import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import {
  FULLSTACK_ACTIVATION_MARKER_BYTES,
  FULLSTACK_ACTIVATION_MARKER_PATH,
  FULLSTACK_ACTIVATION_MARKER_SHA256,
} from '../../fullstack/src/activation-marker.js';

import { buildOmpArgs } from '../src/server.js';
import {
  inspectRuntimePluginRegistry,
  prepareRuntimeScratchProject,
  runtimeExtensionPackagePath,
  UX_E2E_PROJECT_SETTINGS_PATH,
  UX_E2E_RUNTIME_EXTENSION_PACKAGE,
} from '../src/runtime.js';
const MONOREPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/**
 * Regression for OMP v18 extension discovery. The linked package must be
 * selected through the project settings manifest; merely creating a symlink in
 * scratch/node_modules does not make OMP load its `omp.extensions` entry.
 */
test('runtime scratch activates the linked fullstack extension and current import command contract', () => {
  const parent = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-runtime-'));
  const scratch = join(parent, 'scratch');
  mkdirSync(scratch);
  try {
    prepareRuntimeScratchProject(scratch, MONOREPO_ROOT);

    const settingsPath = join(scratch, UX_E2E_PROJECT_SETTINGS_PATH);
    assert.equal(existsSync(settingsPath), true, 'project extension settings are installed');
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8')) as { extensions?: unknown };
    assert.deepEqual(settings.extensions, [UX_E2E_RUNTIME_EXTENSION_PACKAGE]);

    const extensionRoot = resolve(scratch, UX_E2E_RUNTIME_EXTENSION_PACKAGE);
    const fullstackPackage = join(scratch, 'node_modules', '@andvl1', 'omp-workflows-fullstack');
    assert.equal(realpathSync(extensionRoot), realpathSync(fullstackPackage));
    assert.equal(realpathSync(extensionRoot), realpathSync(join(MONOREPO_ROOT, 'packages', 'fullstack')));

    const manifest = JSON.parse(readFileSync(join(extensionRoot, 'package.json'), 'utf8')) as {
      omp?: { extensions?: unknown };
    };
    assert.deepEqual(manifest.omp?.extensions, ['./dist/index.js']);

    const registry = inspectRuntimePluginRegistry(scratch);
    assert.equal(registry.schema_version, 1);
    assert.equal(registry.extension_package.name, '@andvl1/omp-workflows-fullstack');
    assert.equal(registry.core_package.name, '@andvl1/omp-workflows-core');
    const activationMarkerPath = join(scratch, FULLSTACK_ACTIVATION_MARKER_PATH);
    const activationMarkerBytes = readFileSync(activationMarkerPath);
    assert.deepEqual(activationMarkerBytes, FULLSTACK_ACTIVATION_MARKER_BYTES);
    assert.equal(createHash('sha256').update(activationMarkerBytes).digest('hex'), FULLSTACK_ACTIVATION_MARKER_SHA256);

    assert.equal(registry.extension_package.realpath, realpathSync(join(MONOREPO_ROOT, 'packages', 'fullstack')));
    assert.equal(registry.core_package.realpath, realpathSync(join(MONOREPO_ROOT, 'packages', 'core')));
    assert.deepEqual(registry.configured_extensions, [runtimeExtensionPackagePath(scratch)]);
    assert.deepEqual(registry.duplicate_tool_names, []);
    assert.ok(registry.tool_names.includes('constitution_checkpoint_ask_selected'));
    const extensionEntrypoint = resolve(extensionRoot, './dist/index.js');
    assert.equal(existsSync(extensionEntrypoint), true, 'OMP discovery entrypoint exists in the linked package');

    for (const toolName of [
      'workflow_prepare',
      'workflow_instructions',
      'workflow_begin',
      'workflow_checkpoint',
      'workflow_finalize_import_handoff',
    ]) {
      assert.ok(registry.tool_names.includes(toolName), `${toolName} is exposed by the linked runtime registry`);
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('runtime launcher ignores a conflicting ambient plugin and pins one current extension root', () => {
  const parent = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-runtime-conflict-'));
  const scratch = join(parent, 'scratch');
  const ambient = join(parent, 'ambient-plugin');
  mkdirSync(scratch);
  mkdirSync(ambient);
  try {
    prepareRuntimeScratchProject(scratch, MONOREPO_ROOT);
    writeFileSync(
      join(ambient, 'package.json'),
      JSON.stringify({
        name: '@ambient/conflicting-workflows',
        version: '99.0.0',
        type: 'module',
        omp: { extensions: ['./dist/index.js'] },
      }) + '\n',
    );
    // Simulate an ambient/project conflict: this setting would normally add a
    // second provider, but --no-extensions makes it inert for the child.
    writeFileSync(
      join(scratch, UX_E2E_PROJECT_SETTINGS_PATH),
      JSON.stringify({ extensions: [ambient, UX_E2E_RUNTIME_EXTENSION_PACKAGE] }) + '\n',
    );

    const extensionPath = runtimeExtensionPackagePath(scratch);
    const args = buildOmpArgs({
      runtimeExtensionPath: extensionPath,
      maxTimeSec: 60,
      approvalMode: 'yolo',
      configPath: join(scratch, '.omp', 'ux-e2e-overlay.json'),
      sessionDir: join(scratch, '.omp', 'agent'),
      userConfigDefaultPath: join(scratch, '.omp', 'ux-e2e-overlay.user.json'),
    });
    assert.equal(args.filter(value => value === '--no-extensions').length, 1);
    assert.equal(args.filter(value => value === '--extension').length, 1);
    assert.deepEqual(args.slice(0, 4), ['--no-extensions', '--extension', extensionPath, '--config']);
    assert.equal(args.includes(ambient), false, 'ambient plugin path is never passed to omp');

    const registry = inspectRuntimePluginRegistry(scratch);
    assert.deepEqual(registry.configured_extensions, [extensionPath]);
    assert.equal(registry.extension_package.version, '0.27.0');
    assert.equal(registry.core_package.version, '0.27.0');
    assert.deepEqual(registry.duplicate_tool_names, []);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('runtime bootstrap rejects a conflicting marker before copying commands', () => {
  const parent = mkdtempSync(join(tmpdir(), 'omp-ux-e2e-runtime-marker-conflict-'));
  const scratch = join(parent, 'scratch');
  const markerPath = join(scratch, FULLSTACK_ACTIVATION_MARKER_PATH);
  const conflict = Buffer.from('{"schema_version":1,"bundle_id":"other"}\n', 'utf8');
  mkdirSync(join(scratch, '.omp'), { recursive: true });
  writeFileSync(markerPath, conflict);
  try {
    assert.throws(() => prepareRuntimeScratchProject(scratch, MONOREPO_ROOT), /activation marker/u);
    assert.deepEqual(readFileSync(markerPath), conflict);
    assert.equal(existsSync(join(scratch, '.omp', 'commands')), false);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
