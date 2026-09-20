import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Scratch-local manifest written by `ux-e2e bootstrap` and consumed at launch. */
export const WORKSPACE_ACTIVATION_FILE = 'ux-e2e-workspace.json';

export interface WorkspaceActivation {
  readonly monorepoRoot: string;
  readonly corePackage: string;
  readonly fullstackPackage: string;
  readonly fullstackExtension: string;
}

interface StoredWorkspaceActivation {
  readonly monorepo_root?: unknown;
  readonly core_package?: unknown;
  readonly fullstack_package?: unknown;
  readonly fullstack_extension?: unknown;
}

/**
 * Resolve the repository that ships this E2E package.
 *
 * Both `src/*.ts` under tsx and `dist/*.js` after the E2E build have the same
 * package-relative layout, so this remains worktree-derived instead of relying
 * on a developer's absolute checkout path.
 */
export function defaultE2eMonorepoRoot(moduleUrl: string = import.meta.url): string {
  return resolve(dirname(fileURLToPath(moduleUrl)), '..', '..', '..');
}

export function workspaceActivationFor(monorepoRoot: string): WorkspaceActivation {
  const root = resolve(monorepoRoot);
  const corePackage = join(root, 'packages', 'core');
  const fullstackPackage = join(root, 'packages', 'fullstack');
  return {
    monorepoRoot: root,
    corePackage,
    fullstackPackage,
    fullstackExtension: join(fullstackPackage, 'dist', 'index.js'),
  };
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === resolve(value);
}

function decodeStoredActivation(value: unknown): WorkspaceActivation | null {
  if (value === null || typeof value !== 'object') return null;
  const stored = value as StoredWorkspaceActivation;
  if (
    !isAbsolutePath(stored.monorepo_root) ||
    !isAbsolutePath(stored.core_package) ||
    !isAbsolutePath(stored.fullstack_package) ||
    !isAbsolutePath(stored.fullstack_extension)
  ) {
    return null;
  }
  return {
    monorepoRoot: stored.monorepo_root,
    corePackage: stored.core_package,
    fullstackPackage: stored.fullstack_package,
    fullstackExtension: stored.fullstack_extension,
  };
}

export function readWorkspaceActivation(scratchDir: string): WorkspaceActivation | null {
  const manifestPath = join(resolve(scratchDir), '.omp', WORKSPACE_ACTIVATION_FILE);
  if (!existsSync(manifestPath)) return null;
  try {
    return decodeStoredActivation(JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown);
  } catch {
    return null;
  }
}

function writeWorkspaceManifest(activation: WorkspaceActivation, scratchDir: string): void {
  const manifestPath = join(resolve(scratchDir), '.omp', WORKSPACE_ACTIVATION_FILE);
  writeFileSync(
    manifestPath,
    JSON.stringify(
      {
        monorepo_root: activation.monorepoRoot,
        core_package: activation.corePackage,
        fullstack_package: activation.fullstackPackage,
        fullstack_extension: activation.fullstackExtension,
      },
      null,
      2,
    ) + '\n',
  );
}

/**
 * Materialize only the worktree identity used by the launcher. OMP plugin
 * discovery and custom-command dependency installation are intentionally not
 * modified here; the child receives the explicit extension path below.
 */
export function ensureWorkspaceActivation(
  scratchDir: string,
  monorepoRoot: string = defaultE2eMonorepoRoot(),
): WorkspaceActivation | null {
  const scratch = resolve(scratchDir);
  mkdirSync(join(scratch, '.omp'), { recursive: true });
  const activation = readWorkspaceActivation(scratch) ?? workspaceActivationFor(monorepoRoot);
  if (
    !existsSync(join(activation.corePackage, 'package.json')) ||
    !existsSync(join(activation.fullstackPackage, 'package.json')) ||
    !existsSync(activation.fullstackExtension)
  ) {
    return null;
  }
  writeWorkspaceManifest(activation, scratch);
  return activation;
}

/** Write activation files during bootstrap and return their provenance. */
export function materializeWorkspaceActivation(monorepoRoot: string, scratchDir: string): WorkspaceActivation {
  const activation = workspaceActivationFor(monorepoRoot);
  if (
    !existsSync(join(activation.corePackage, 'package.json')) ||
    !existsSync(join(activation.fullstackPackage, 'package.json')) ||
    !existsSync(activation.fullstackExtension)
  ) {
    throw new Error(`ux-e2e bootstrap: monorepo layout not found under ${activation.monorepoRoot} (expected packages/core, packages/fullstack, and fullstack dist)`);
  }
  const result = ensureWorkspaceActivation(scratchDir, activation.monorepoRoot);
  if (result === null) throw new Error(`ux-e2e bootstrap: failed to record worktree under ${activation.monorepoRoot}`);
  return result;
}
