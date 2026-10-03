import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { loadScenario } from '../src/scenario.js';

const TEST_DIR = dirname(fileURLToPath(import.meta.url));
const FULL_FEATURE_SCENARIO = join(TEST_DIR, '..', 'scenarios', 'full-feature.json');
const CORE_FULL_FEATURE = join(TEST_DIR, '..', '..', 'core', 'workflows', 'full-feature.json');

test('qa-regression: full-feature scenario resolves task inputs and matches the shipped workflow stages', () => {
  const scenario = loadScenario(FULL_FEATURE_SCENARIO, { slug: 'isolated-run', branch: 'feat/isolated-run' });
  const coreWorkflow = JSON.parse(readFileSync(CORE_FULL_FEATURE, 'utf8')) as { stages: Array<{ id: string }> };

  assert.ok(scenario.task.length > 0);
  assert.ok(!/\{\{[^}]+\}\}/u.test(scenario.task));
  assert.deepEqual(
    scenario.stages.map(stage => stage.id),
    coreWorkflow.stages.map(stage => stage.id),
  );
});
