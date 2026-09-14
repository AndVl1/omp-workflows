import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, parse, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  createScratchSpecificationRepository,
  listSpecificationBundleFixtures,
  loadSpecificationBundleFixture,
  materializeSpecificationBundleFixture,
  specificationFixtureRoot,
} from '../src/specification-fixtures.js';

function freshParent(label: string): string {
  return mkdtempSync(join(tmpdir(), `spec-scratch-${label}-`));
}

test('default specification fixtures resolve to the shipped package tree', () => {
  const root = specificationFixtureRoot();
  assert.equal(existsSync(root), true);
  assert.equal(existsSync(join(root, 'speckit', 'complete')), true);
  const bundle = loadSpecificationBundleFixture('speckit/complete');
  assert.equal(bundle.descriptor.id, 'speckit/complete');
  assert.ok(bundle.entries.length > 0);
});

test('an explicit specification fixture root remains authoritative', () => {
  const override = freshParent('fixture-root');
  try {
    assert.equal(specificationFixtureRoot(override), resolve(override));
  } finally {
    rmSync(override, { recursive: true, force: true });
  }
});

test('all safe bundle fixtures remain supported by one scratch repository', () => {
  const parent = freshParent('all-bundles');
  try {
    const descriptors = listSpecificationBundleFixtures();
    assert.equal(descriptors.length, 30);
    const safeDescriptors = descriptors.filter(({ state }) => state !== 'hostile');
    const before = new Map(safeDescriptors.map(({ id }) => [id, loadSpecificationBundleFixture(id).digest]));
    const result = createScratchSpecificationRepository({
      workdir: parent,
      slug: 'all-safe',
      bundles: safeDescriptors.map(({ id }) => ({ id, as: `bundles/${id.replace('/', '-')}` })),
      constitution: { variant: 'usable', path: 'policy/CONSTITUTION.md' },
      legacyRun: { featureId: 'payment-retry' },
      extraFiles: [{ path: 'README.txt', contents: 'deterministic scratch fixture\n' }],
      git: { init: false },
    });

    assert.equal(result.root, join(realpathSync(parent), 'omp-spec-e2e-all-safe'));
    assert.equal(result.bundles.length, 24);
    assert.equal(result.constitution?.path, 'policy/CONSTITUTION.md');
    assert.equal(existsSync(join(result.root, 'README.txt')), true);
    for (const materialized of result.bundles) {
      assert.equal(existsSync(join(result.root, materialized.path)), true);
      assert.equal(materialized.digest, before.get(materialized.id));
      assert.equal(loadSpecificationBundleFixture(materialized.id).digest, before.get(materialized.id));
    }
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('hostile symlinks are captured inertly and materialized only in authorized scratch', () => {
  const parent = freshParent('hostile-symlink');
  try {
    const loaded = loadSpecificationBundleFixture('speckit/hostile');
    const escape = loaded.entries.find(entry => entry.path === 'notes/escape.md');
    assert.ok(escape !== undefined);
    assert.equal(escape.kind, 'symlink');
    if (escape.kind !== 'symlink') return;
    assert.equal(escape.symlink_target, '../../../../../src/util.ts');

    const target = join(parent, 'materialized');
    const materialized = materializeSpecificationBundleFixture('speckit/hostile', target);
    const materializedEscape = materialized.entries.find(entry => entry.path === 'notes/escape.md');
    assert.equal(materializedEscape?.kind, 'symlink');
    assert.equal(lstatSync(join(target, 'notes', 'escape.md')).isSymbolicLink(), true);
    assert.equal(readlinkSync(join(target, 'notes', 'escape.md')), escape.symlink_target);
    assert.equal(existsSync(join(target, 'notes', 'escape.md', 'not-followed')), false);
    assert.deepEqual(readdirSync(parent), ['materialized']);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});


test('every descriptor and destination is preflighted before the first write', () => {
  const invalidCases = [
    {
      label: 'constitution traversal',
      options: { constitution: { variant: 'usable' as const, path: '../outside.md' } },
      error: /relative POSIX path|unsafe segment/,
    },
    {
      label: 'constitution-extra duplicate',
      options: {
        constitution: { variant: 'usable' as const, path: 'policy.md' },
        extraFiles: [{ path: 'policy.md', contents: 'collision' }],
      },
      error: /scratch path collision/,
    },
    {
      label: 'extra ancestor collision',
      options: {
        extraFiles: [
          { path: 'docs', contents: 'file' },
          { path: 'docs/child.md', contents: 'must not traverse a file destination' },
        ],
      },
      error: /scratch path collision/,
    },
    {
      label: 'bundle target collision',
      options: {
        bundles: [
          { id: 'speckit/complete', as: 'source' },
          { id: 'openspec/complete', as: 'source/nested' },
        ],
      },
      error: /bundle target collision/,
    },
    {
      label: 'unknown bundle descriptor',
      options: { bundles: [{ id: 'unknown/fixture', as: 'source' }] },
      error: /unknown bundle id/,
    },
    {
      label: 'git metadata collision',
      options: { extraFiles: [{ path: '.git/config', contents: 'hostile' }] },
      error: /reserved for git metadata/,
    },
  ] as const;

  for (const invalid of invalidCases) {
    const parent = freshParent(invalid.label.replaceAll(' ', '-'));
    try {
      assert.throws(
        () => createScratchSpecificationRepository({
          workdir: parent,
          slug: 'preflight',
          git: { init: invalid.label === 'git metadata collision' },
          ...invalid.options,
        }),
        invalid.error,
      );
      assert.deepEqual(readdirSync(parent), [], invalid.label);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  }
});

test('overwrite refuses an arbitrary unowned target without deleting it', () => {
  const parent = freshParent('arbitrary-overwrite');
  const root = join(parent, 'omp-spec-e2e-protected');
  const sentinel = join(root, 'sentinel.txt');
  try {
    mkdirSync(root);
    writeFileSync(sentinel, 'preserve me', 'utf8');
    assert.throws(
      () => createScratchSpecificationRepository({
        workdir: parent,
        slug: 'protected',
        overwrite: true,
        git: { init: false },
      }),
      /previously owned by this API/,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve me');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('overwrite refuses a symlink scratch target and preserves its victim', () => {
  const parent = freshParent('symlink-root');
  const victim = freshParent('symlink-victim');
  const sentinel = join(victim, 'sentinel.txt');
  try {
    const first = createScratchSpecificationRepository({
      workdir: parent,
      slug: 'linked',
      extraFiles: [{ path: 'first.txt', contents: 'first' }],
      git: { init: false },
    });
    rmSync(first.root, { recursive: true, force: true });
    writeFileSync(sentinel, 'preserve victim', 'utf8');
    symlinkSync(victim, first.root, 'dir');

    assert.throws(
      () => createScratchSpecificationRepository({
        workdir: parent,
        slug: 'linked',
        overwrite: true,
        git: { init: false },
      }),
      /not a symlink or special file/,
    );
    assert.equal(readFileSync(sentinel, 'utf8'), 'preserve victim');
  } finally {
    rmSync(parent, { recursive: true, force: true });
    rmSync(victim, { recursive: true, force: true });
  }
});

test('scratch parent rejects symlink aliases, filesystem root, and project root', () => {
  const container = freshParent('unsafe-parents');
  const realParent = join(container, 'real-parent');
  const alias = join(container, 'alias-parent');
  try {
    mkdirSync(realParent);
    symlinkSync(realParent, alias, 'dir');
    assert.throws(
      () => createScratchSpecificationRepository({ workdir: alias, slug: 'alias', git: { init: false } }),
      /real directory|canonical path/,
    );

    assert.throws(
      () => createScratchSpecificationRepository({ workdir: parse(container).root, slug: 'root', git: { init: false } }),
      /filesystem root/,
    );

    const projectRoot = resolve(fileURLToPath(new URL('../../..', import.meta.url)));
    assert.throws(
      () => createScratchSpecificationRepository({ workdir: projectRoot, slug: 'project', git: { init: false } }),
      /project root/,
    );
    assert.deepEqual(readdirSync(realParent), []);
  } finally {
    rmSync(container, { recursive: true, force: true });
  }
});

test('overwrite succeeds only for a canonical child of the API-owned parent', () => {
  const parent = freshParent('owned-overwrite');
  try {
    const first = createScratchSpecificationRepository({
      workdir: parent,
      slug: 'owned',
      extraFiles: [{ path: 'old.txt', contents: 'old' }],
      git: { init: false },
    });
    const second = createScratchSpecificationRepository({
      workdir: parent,
      slug: 'owned',
      overwrite: true,
      extraFiles: [{ path: 'new.txt', contents: 'new' }],
      git: { init: false },
    });

    assert.equal(second.root, first.root);
    assert.equal(existsSync(join(second.root, 'old.txt')), false);
    assert.equal(readFileSync(join(second.root, 'new.txt'), 'utf8'), 'new');
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});
