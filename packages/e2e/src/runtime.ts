import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomically } from './overlay.js';
import { closePinnedDirectory, pinChildDirectory, pinDirectory, pinOrCreateDirectory, pinnedDirectoryIsStable, readPinnedFileFull, writePinnedFile, type PinnedDirectory, type PinnedDirectoryCreationReceipt } from './fs-safety.js';
import {
  FULLSTACK_ACTIVATION_MARKER_PATH,
  validateFullstackActivationMarkerDestination,
  writeFullstackActivationMarker,
} from '@andvl1/omp-workflows-fullstack/activation-marker';
/** Project settings path consumed by OMP v18 extension discovery. */
export const UX_E2E_PROJECT_SETTINGS_PATH = '.omp/settings.json';
/** Root-bound provenance proving that a scratch was explicitly bootstrapped by this harness. */
export const UX_E2E_BOOTSTRAP_PROVENANCE_PATH = '.work-state/ux-e2e/bootstrap-provenance.json';
export interface UxE2eBootstrapProvenanceInput {
  readonly slug: string;
  readonly branch: string;
  readonly monorepoRoot: string;
  readonly coreTarget: string;
}

/** Relative linked package root whose manifest owns runtime registration. */
export const UX_E2E_RUNTIME_EXTENSION_PACKAGE = 'node_modules/@andvl1/omp-workflows-fullstack';
/** Resolve the absolute fullstack package root used by every real OMP child. */
export function runtimeExtensionPackagePath(scratchDir: string): string {
  return resolve(scratchDir, UX_E2E_RUNTIME_EXTENSION_PACKAGE);
}

function normalizeDarwinTmpAlias(path: string): string {
  if (process.platform === 'darwin' && (path === '/tmp' || path.startsWith('/tmp/'))) return `/private${path}`;
  return path;
}

/**
 * Persist explicit bootstrap provenance; scenario setup accepts only this record.
 * The record is a local capability, not a credential: a same-UID actor able to
 * copy and rewrite the entire scratch tree is inside the filesystem trust
 * boundary, while accidental use of a production/ambient root is rejected.
 */
export function writeUxE2eBootstrapProvenance(
  scratchDir: string,
  input: UxE2eBootstrapProvenanceInput,
  pinnedRoot?: PinnedDirectory,
): void {
  const lexical = resolve(scratchDir);
  const canonical = resolve(realpathSync(lexical));
  if (normalizeDarwinTmpAlias(lexical) !== normalizeDarwinTmpAlias(canonical)) {
    throw new Error('ux-e2e: bootstrap scratch root must not have a symlinked ancestor or root');
  }
  const packagePath = join(canonical, 'package.json');
  const packageStat = lstatSync(packagePath);
  if (!packageStat.isFile() || packageStat.isSymbolicLink() || packageStat.nlink !== 1) {
    throw new Error('ux-e2e: bootstrap package manifest is not a private regular file');
  }
  const packageManifest = JSON.parse(readFileSync(packagePath, 'utf8')) as { name?: unknown; private?: unknown };
  if (packageManifest.private !== true || packageManifest.name !== `omp-ux-e2e-${input.slug}`) {
    throw new Error('ux-e2e: bootstrap package identity is not private and harness-owned');
  }
  const monorepo = resolve(realpathSync(input.monorepoRoot));
  const core = resolve(realpathSync(input.coreTarget));
  const expectedCore = resolve(monorepo, 'packages', 'core');
  if (core !== expectedCore) throw new Error('ux-e2e: bootstrap core target is outside the selected monorepo');
  const provenance = {
    schema_version: 1,
    kind: 'ux-e2e-bootstrap',
    canonical_root: canonical,
    root_basename: basename(canonical),
    slug: input.slug,
    branch: input.branch,
    monorepo_root: monorepo,
    core_target: core,
    nonce: randomUUID(),
  } as const;
  writeJsonAtomically(canonical, UX_E2E_BOOTSTRAP_PROVENANCE_PATH, provenance, '.ux-e2e-bootstrap-provenance-', pinnedRoot);
}


export interface RuntimePackageIdentity {
  readonly name: string;
  readonly version: string;
  readonly package_path: string;
  readonly realpath: string;
  readonly entrypoint: string;
}

export interface RuntimePluginRegistry {
  readonly schema_version: 1;
  readonly extension_package: RuntimePackageIdentity;
  readonly core_package: RuntimePackageIdentity;
  readonly configured_extensions: readonly string[];
  readonly tool_names: readonly string[];
  readonly duplicate_tool_names: readonly string[];
}

const MAX_RUNTIME_MANIFEST_BYTES = 64 * 1024;
const MAX_RUNTIME_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_RUNTIME_SOURCE_FILES = 4096;

function readPackageIdentity(packagePath: string, expectedName: string): RuntimePackageIdentity {
  const realPackagePath = realpathSync(packagePath);
  const manifestPath = join(realPackagePath, 'package.json');
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || manifestStat.size > MAX_RUNTIME_MANIFEST_BYTES) {
    throw new Error(`ux-e2e: runtime package manifest is not a bounded regular file: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { name?: unknown; version?: unknown; main?: unknown };
  if (manifest.name !== expectedName || typeof manifest.version !== 'string' || manifest.version.length === 0) {
    throw new Error(`ux-e2e: runtime package identity mismatch at ${manifestPath}`);
  }
  const entrypoint = resolve(realPackagePath, typeof manifest.main === 'string' && manifest.main.length > 0 ? manifest.main : 'dist/index.js');
  const entrypointStat = lstatSync(entrypoint);
  if (!entrypointStat.isFile() || entrypointStat.isSymbolicLink() || entrypointStat.size > MAX_RUNTIME_SOURCE_BYTES) {
    throw new Error(`ux-e2e: runtime package entrypoint is not a bounded regular file: ${entrypoint}`);
  }
  return {
    name: manifest.name,
    version: manifest.version,
    package_path: resolve(packagePath),
    realpath: realPackagePath,
    entrypoint,
  };
}

function collectRuntimeSourceFiles(root: string, files: string[] = [], depth = 0): string[] {
  if (depth > 8 || files.length > MAX_RUNTIME_SOURCE_FILES) {
    throw new Error(`ux-e2e: runtime package source tree exceeds diagnostic bounds: ${root}`);
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      collectRuntimeSourceFiles(path, files, depth + 1);
      continue;
    }
    if (!entry.isFile() || !/\.m?js$/u.test(entry.name)) continue;
    const fileStat = statSync(path);
    if (fileStat.size > MAX_RUNTIME_SOURCE_BYTES) {
      throw new Error(`ux-e2e: runtime package source file exceeds diagnostic bounds: ${path}`);
    }
    files.push(path);
  }
  return files;
}

function registeredToolNames(packageRoot: string): string[] {
  const names: string[] = [];
  const pattern = /(?:^|\.)registerTool\(\{\s*name:\s*["']([^"']+)["']/gu;
  for (const path of collectRuntimeSourceFiles(join(packageRoot, 'dist'))) {
    const source = readFileSync(path, 'utf8');
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name !== undefined) names.push(name);
    }
  }
  return names;
}

/**
 * Return the exact package identities and tool registry the launcher is
 * allowed to expose. This is persisted as session diagnostics and lets tests
 * prove that an ambient installed plugin cannot add a second tool provider.
 */
export function inspectRuntimePluginRegistry(
  scratchDir: string,
  projectRoot: string = DEFAULT_PROJECT_ROOT,
): RuntimePluginRegistry {
  const extensionPath = runtimeExtensionPackagePath(scratchDir);
  const corePath = resolve(scratchDir, 'node_modules', '@andvl1', 'omp-workflows-core');
  const extension = readPackageIdentity(extensionPath, '@andvl1/omp-workflows-fullstack');
  const core = readPackageIdentity(corePath, '@andvl1/omp-workflows-core');
  const expectedExtension = realpathSync(join(resolve(projectRoot), 'packages', 'fullstack'));
  const expectedCore = realpathSync(join(resolve(projectRoot), 'packages', 'core'));
  if (extension.realpath !== expectedExtension || core.realpath !== expectedCore) {
    throw new Error('ux-e2e: runtime plugin registry is not backed by the current workspace packages');
  }
  const names = [...registeredToolNames(core.realpath), ...registeredToolNames(extension.realpath)];
  const counts = new Map<string, number>();
  for (const name of names) counts.set(name, (counts.get(name) ?? 0) + 1);
  const duplicateToolNames = [...counts.entries()].filter(([, count]) => count > 1).map(([name]) => name).sort();
  return {
    schema_version: 1,
    extension_package: extension,
    core_package: core,
    configured_extensions: [extensionPath],
    tool_names: [...new Set(names)].sort(),
    duplicate_tool_names: duplicateToolNames,
  };
}
const DEFAULT_PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function linkTargetMatches(path: string, target: string): boolean {
  try {
    const entry = lstatSync(path);
    if (!entry.isSymbolicLink()) return false;
    return realpathSync(path) === realpathSync(target);
  } catch {
    return false;
  }
}

function runtimePackagesLinked(
  scratchDir: string,
  corePackage: string,
  fullstackPackage: string,
): boolean {
  const coreLink = linkTargetMatches(
    join(scratchDir, 'node_modules', '@andvl1', 'omp-workflows-core'),
    corePackage,
  );
  const fullstackLink = linkTargetMatches(
    join(scratchDir, 'node_modules', '@andvl1', 'omp-workflows-fullstack'),
    fullstackPackage,
  );
  return coreLink && fullstackLink;
}

/**
 * Wire a scratch repository to the current monorepo's real OMP extensions.
 * This is intentionally separate from the data-only specification fixture
 * builder: npm link is runtime setup, not fixture content generation.
 */
export function prepareRuntimeScratchProject(
  scratchDir: string,
  projectRoot: string = DEFAULT_PROJECT_ROOT,
  pinnedRoot?: PinnedDirectory,
): void {
  // Preflight before any scratch bootstrap side effect: a malformed, edited,
  // symlinked, or wrong-kind marker must preserve the project exactly.
  validateFullstackActivationMarkerDestination(scratchDir);

  const monorepo = resolve(projectRoot);
  const corePackage = join(monorepo, 'packages', 'core');
  const fullstackPackage = join(monorepo, 'packages', 'fullstack');
  if (!existsSync(join(corePackage, 'package.json')) || !existsSync(join(fullstackPackage, 'package.json'))) {
    throw new Error(`ux-e2e: monorepo layout not found under ${monorepo} (expected packages/core and packages/fullstack)`);
  }

  if (!existsSync(join(scratchDir, 'package.json'))) {
    writeFileSync(
      join(scratchDir, 'package.json'),
      `${JSON.stringify({ name: `omp-ux-e2e-${basename(scratchDir)}`, version: '0.0.0', private: true, type: 'module' }, null, 2)}\n`,
      { encoding: 'utf8', flag: 'wx' },
    );
  }

  if (!runtimePackagesLinked(scratchDir, corePackage, fullstackPackage)) {
    execFileSync('npm', ['link', corePackage, fullstackPackage], {
      cwd: scratchDir,
      stdio: 'ignore',
      env: { ...process.env, OMP_PROJECT_DIR: scratchDir },
    });
  }

  const ompDir = join(scratchDir, '.omp');
  const created: PinnedDirectoryCreationReceipt[] = [];
  const ompRoot = pinnedRoot === undefined
    ? pinOrCreateDirectory(ompDir)
    : pinChildDirectory(pinnedRoot, ['.omp'], created);
  if (ompRoot === null) {
    closePinnedDirectoryCreationReceipts(created);
    throw new Error('ux-e2e: scratch .omp directory is not a stable non-symlink directory');
  }
  try {
    if (!pinnedDirectoryIsStable(ompRoot)) throw new Error('ux-e2e: scratch .omp directory changed during setup');
    // OMP v18 does not treat arbitrary scratch `node_modules` entries as
    // extensions. The project settings file is the supported discovery seam:
    // point it at the linked package root so OMP resolves its `omp.extensions`
    // manifest and executes the current dynamic command registration.
    writeJsonAtomically(
      scratchDir,
      UX_E2E_PROJECT_SETTINGS_PATH,
      { extensions: [UX_E2E_RUNTIME_EXTENSION_PACKAGE] },
      '.ux-e2e-settings-',
      pinnedRoot,
    );
    const teamConfig = join(monorepo, '.omp', 'team.config.json');
    const targetTeamConfig = join(ompDir, 'team.config.json');
    if (existsSync(teamConfig) && !existsSync(targetTeamConfig)) {
      const sourceStat = lstatSync(teamConfig);
      if (!sourceStat.isFile() || sourceStat.isSymbolicLink() || sourceStat.nlink !== 1 || sourceStat.size > 8 * 1024 * 1024) {
        throw new Error('ux-e2e: monorepo team.config.json is not a bounded regular file');
      }
      const sourceRoot = pinDirectory(dirname(teamConfig));
      const content = sourceRoot === null
        ? null
        : readPinnedFileFull(sourceRoot, basename(teamConfig), 8 * 1024 * 1024);
      if (sourceRoot !== null) closePinnedDirectory(sourceRoot);
      if (content === null) throw new Error('ux-e2e: team.config.json changed or could not be read safely');
      if (!writePinnedFile(ompRoot, 'team.config.json', content)) {
        throw new Error('ux-e2e: failed to install team.config.json safely');
      }
    }
  } finally {
    closePinnedDirectory(ompRoot);
  }

  // The package copy script is only the compatibility path for fullstack's
  // project-local custom commands. Core specification commands (including
  // `/spec-import`) are registered dynamically by the extension manifest above;
  // copying this tree cannot create that command in OMP v18.
  // The marker destination was preflighted before bootstrap; this explicit
  // compatibility copy is now safe to run before the final marker commit.

  const copyScript = join(fullstackPackage, 'scripts', 'copy-commands.mjs');
  if (existsSync(copyScript)) {
    execFileSync(process.execPath, [copyScript, scratchDir], {
      cwd: scratchDir,
      stdio: 'ignore',
      env: { ...process.env, OMP_PROJECT_DIR: scratchDir },
    });
  }
  // The marker is written only after the explicit compatibility installer
  // succeeds, and is never created by ordinary extension/session startup.
  writeFullstackActivationMarker(scratchDir);
  if (!existsSync(join(scratchDir, FULLSTACK_ACTIVATION_MARKER_PATH))) {
    throw new Error('ux-e2e: fullstack activation marker was not materialized');
  }

  // npm link creates these entries. Keep a defensive check here so a future
  // package-manager change cannot silently launch a scratch without the
  // current extension packages.
  if (!runtimePackagesLinked(scratchDir, corePackage, fullstackPackage)) {
    throw new Error(`ux-e2e: failed to link current core/fullstack packages into ${scratchDir}`);
  }
}
