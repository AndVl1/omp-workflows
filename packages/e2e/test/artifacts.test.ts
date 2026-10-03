import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';

import {
  buildPackageArtifact,
  materializeDependencyClosure,
  verifyPackageArtifact,
} from '../src/artifacts.js';

function writePackage(root: string, name: string, version: string, source: string, dependencies: Record<string, string> = {}): void {
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), `${JSON.stringify({
    name,
    version,
    type: 'module',
    main: 'dist/index.js',
    files: ['dist'],
    dependencies,
  })}\n`);
  writeFileSync(join(root, 'dist', 'index.js'), source);
}

test('materializes two installed versions at their Node resolution paths', async t => {
  const scratch = mkdtempSync(join(tmpdir(), 'e2e-artifact-nested-'));
  t.after(() => rmSync(scratch, { recursive: true, force: true }));

  const checkout = join(scratch, 'checkout');
  const appRoot = join(checkout, 'app');
  const rootDependency = join(checkout, 'node_modules', 'versioned-dependency');
  const consumerRoot = join(checkout, 'node_modules', 'nested-consumer');
  const nestedDependency = join(consumerRoot, 'node_modules', 'versioned-dependency');
  writePackage(
    appRoot,
    'fixture-app',
    '1.0.0',
    "import { version as rootVersion } from 'versioned-dependency';\nimport { nestedVersion } from 'nested-consumer';\nexport { rootVersion, nestedVersion };\n",
    { 'versioned-dependency': '^1.0.0', 'nested-consumer': '^1.0.0' },
  );
  writePackage(rootDependency, 'versioned-dependency', '1.0.0', "export const version = 'root-v1';\n");
  writePackage(
    consumerRoot,
    'nested-consumer',
    '1.0.0',
    "import { version } from 'versioned-dependency';\nexport const nestedVersion = version;\n",
    { 'versioned-dependency': '^2.0.0' },
  );
  writePackage(nestedDependency, 'versioned-dependency', '2.0.0', "export const version = 'nested-v2';\n");

  const cacheRoot = join(scratch, 'cache');
  const artifact = buildPackageArtifact(appRoot, cacheRoot, {
    dependencyRoots: [
      { name: 'versioned-dependency', root: rootDependency, relativePath: 'node_modules/versioned-dependency' },
      { name: 'nested-consumer', root: consumerRoot, relativePath: 'node_modules/nested-consumer' },
      { name: 'versioned-dependency', root: nestedDependency, relativePath: 'node_modules/nested-consumer/node_modules/versioned-dependency' },
    ],
  });
  assert.equal(verifyPackageArtifact(artifact.root).digest, artifact.digest);

  // Runtime-selected file URLs exercise Node's actual package resolution boundary.
  const installed = await import(`${pathToFileURL(join(appRoot, 'dist', 'index.js')).href}?installed`);
  assert.equal(installed.rootVersion, 'root-v1');
  assert.equal(installed.nestedVersion, 'nested-v2');

  rmSync(checkout, { recursive: true, force: true });
  const workspace = join(scratch, 'workspace');
  materializeDependencyClosure(workspace, [{ name: artifact.name, artifact }]);
  // The checkout is gone; only the immutable artifact is available now.
  const isolated = await import(`${pathToFileURL(join(workspace, 'node_modules', 'fixture-app', 'dist', 'index.js')).href}?isolated`);
  assert.equal(isolated.rootVersion, 'root-v1');
  assert.equal(isolated.nestedVersion, 'nested-v2');
});
