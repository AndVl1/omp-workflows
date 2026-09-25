import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Scratch-local manifest written by `ux-e2e bootstrap` and consumed at launch. */
export const WORKSPACE_ACTIVATION_FILE = 'ux-e2e-workspace.json';
export const WORKSPACE_PLUGIN_OVERRIDE_FILE = 'plugin-overrides.json';
export const WORKSPACE_DISABLED_PLUGINS = [
  '@andvl1/omp-workflows-core',
  '@andvl1/omp-workflows-fullstack',
] as const;

export interface WorkspaceActivation {
  readonly monorepoRoot: string;
  readonly corePackage: string;
  readonly fullstackPackage: string;
  readonly fullstackExtension: string;
  readonly coreLink: string;
  readonly fullstackLink: string;
  readonly pluginOverridePath: string;
  readonly disabledPlugins: readonly string[];
}

interface StoredWorkspaceActivation {
  readonly monorepo_root?: unknown;
  readonly core_package?: unknown;
  readonly fullstack_package?: unknown;
  readonly fullstack_extension?: unknown;
  readonly core_link?: unknown;
  readonly fullstack_link?: unknown;
  readonly plugin_override_path?: unknown;
  readonly disabled_plugins?: unknown;
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

export function workspaceActivationFor(monorepoRoot: string, scratchDir: string): WorkspaceActivation {
  const root = resolve(monorepoRoot);
  const scratch = resolve(scratchDir);
  const corePackage = join(root, 'packages', 'core');
  const fullstackPackage = join(root, 'packages', 'fullstack');
  return {
    monorepoRoot: root,
    corePackage,
    fullstackPackage,
    fullstackExtension: fullstackPackage,
    coreLink: join(scratch, 'node_modules', '@andvl1', 'omp-workflows-core'),
    fullstackLink: join(scratch, 'node_modules', '@andvl1', 'omp-workflows-fullstack'),
    pluginOverridePath: join(scratch, '.omp', WORKSPACE_PLUGIN_OVERRIDE_FILE),
    disabledPlugins: WORKSPACE_DISABLED_PLUGINS,
  };
}

function isAbsolutePath(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value === resolve(value);
}

function isPluginNameList(value: unknown): value is readonly string[] {
  return (
    Array.isArray(value) &&
    value.length === WORKSPACE_DISABLED_PLUGINS.length &&
    value.every((name, index) => name === WORKSPACE_DISABLED_PLUGINS[index])
  );
}

function decodeStoredActivation(value: unknown): WorkspaceActivation | null {
  if (value === null || typeof value !== 'object') return null;
  const stored = value as StoredWorkspaceActivation;
  if (
    !isAbsolutePath(stored.monorepo_root) ||
    !isAbsolutePath(stored.core_package) ||
    !isAbsolutePath(stored.fullstack_package) ||
    !isAbsolutePath(stored.fullstack_extension) ||
    !isAbsolutePath(stored.core_link) ||
    !isAbsolutePath(stored.fullstack_link) ||
    !isAbsolutePath(stored.plugin_override_path) ||
    !isPluginNameList(stored.disabled_plugins)
  ) {
    return null;
  }
  return {
    monorepoRoot: stored.monorepo_root,
    corePackage: stored.core_package,
    fullstackPackage: stored.fullstack_package,
    fullstackExtension: stored.fullstack_extension,
    coreLink: stored.core_link,
    fullstackLink: stored.fullstack_link,
    pluginOverridePath: stored.plugin_override_path,
    disabledPlugins: stored.disabled_plugins,
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
        core_link: activation.coreLink,
        fullstack_link: activation.fullstackLink,
        plugin_override_path: activation.pluginOverridePath,
        disabled_plugins: activation.disabledPlugins,
      },
      null,
      2,
    ) + '\n',
  );
}

function writePluginOverride(activation: WorkspaceActivation): void {
  writeFileSync(
    activation.pluginOverridePath,
    JSON.stringify({ disabled: activation.disabledPlugins }, null, 2) + '\n',
  );
}

/**
 * Materialize the worktree identity used by the launcher and disable the
 * ambient user copies of the workflow packages for this scratch project. The
 * child still receives the explicit worktree extension path below.
 */
export function ensureWorkspaceActivation(
  scratchDir: string,
  monorepoRoot: string = defaultE2eMonorepoRoot(),
): WorkspaceActivation | null {
  const scratch = resolve(scratchDir);
  mkdirSync(join(scratch, '.omp'), { recursive: true });
  const expectedOverridePath = join(scratch, '.omp', WORKSPACE_PLUGIN_OVERRIDE_FILE);
  const stored = readWorkspaceActivation(scratch);
  const activation =
    stored !== null && stored.pluginOverridePath === expectedOverridePath
      ? stored
      : workspaceActivationFor(monorepoRoot, scratch);
  if (
    !existsSync(join(activation.corePackage, 'package.json')) ||
    !existsSync(join(activation.fullstackPackage, 'package.json')) ||
    !existsSync(join(activation.fullstackExtension, 'package.json'))
  ) {
    return null;
  }
  writePluginOverride(activation);
  writeWorkspaceManifest(activation, scratch);
  return activation;
}

/** Write activation files during bootstrap and return their provenance. */
export function materializeWorkspaceActivation(monorepoRoot: string, scratchDir: string): WorkspaceActivation {
  const activation = workspaceActivationFor(monorepoRoot, scratchDir);
  if (
    !existsSync(join(activation.corePackage, 'package.json')) ||
    !existsSync(join(activation.fullstackPackage, 'package.json')) ||
    !existsSync(join(activation.fullstackExtension, 'package.json'))
  ) {
    throw new Error(`ux-e2e bootstrap: monorepo layout not found under ${activation.monorepoRoot} (expected packages/core, packages/fullstack, and fullstack package)`);
  }
  const result = ensureWorkspaceActivation(scratchDir, activation.monorepoRoot);
  if (result === null) throw new Error(`ux-e2e bootstrap: failed to record worktree under ${activation.monorepoRoot}`);
  return result;
}
