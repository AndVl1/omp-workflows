/**
 * Scenario tests: schema validation (errors carry field names), task
 * file resolution, and {{param}} template expansion.
 */

import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { expandTemplate, loadScenario } from '../src/scenario.js';

const SCENARIOS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'scenarios');
const FULL_FEATURE = join(SCENARIOS_DIR, 'full-feature.json');

test('scenario: loadScenario loads the built-in full-feature scenario', () => {
  const scenario = loadScenario(FULL_FEATURE, { slug: 'my-feature', branch: 'feat/x' });

  assert.equal(scenario.id, 'full-feature');
  assert.equal(scenario.stages.length, 10);
  assert.deepEqual(
    scenario.stages.map(s => s.id),
    [
      'discovery',
      'exploration',
      'clarify',
      'architecture',
      'implementation',
      'code_review',
      'review_fixes',
      'manual_qa',
      'qa_tests',
      'summary',
    ],
  );
  const clarify = scenario.stages[2];
  assert.ok(clarify !== undefined && clarify.ask_user !== undefined);
  assert.equal(clarify.ask_user[0]?.count, 6, 'clarify expects 6 ask_user prompts');
  const architecture = scenario.stages[3];
  assert.ok(architecture !== undefined && architecture.ask_user !== undefined);
  assert.equal(architecture.ask_user[0]?.answer, '1', 'architecture choice answers option #1');
  assert.ok(scenario.task.length > 0, 'task file content is resolved to a string');
  assert.ok(scenario.task.includes('feat/x'), '{{branch}} expanded in the task');
});

test('scenario: missing/invalid fields throw with field names', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-scenario-'));

  const write = (name: string, obj: unknown): string => {
    const p = join(dir, name);
    writeFileSync(p, JSON.stringify(obj));
    return p;
  };

  const valid = {
    id: 'x',
    title: 'X',
    task: 'do it',
    stages: [{ id: 's1', name: 'S1' }],
    timing: { startupTimeoutMs: 1, stageTimeoutMs: 2, checkpointPollMs: 3 },
    screenshots: { on: ['stage_start'] },
    ratings: { dimensions: ['message_clarity'], min: 1, max: 5 },
  };

  assert.throws(() => loadScenario(write('missing-id.json', { ...valid, id: undefined })), /"id"/u);
  assert.throws(() => loadScenario(write('missing-title.json', { ...valid, title: '' })), /"title"/u);
  assert.throws(() => loadScenario(write('missing-stages.json', { ...valid, stages: [] })), /"stages"/u);
  assert.throws(
    () => loadScenario(write('bad-stage.json', { ...valid, stages: [{ name: 'no id' }] })),
    /stages\[0\]\.id/u,
  );
  assert.throws(
    () => loadScenario(write('bad-timing.json', { ...valid, timing: { startupTimeoutMs: 'x' } })),
    /timing\.startupTimeoutMs/u,
  );
  assert.throws(
    () => loadScenario(write('bad-trigger.json', { ...valid, screenshots: { on: ['stage_mid'] } })),
    /screenshots\.on/u,
  );
  assert.throws(
    () => loadScenario(write('bad-ratings.json', { ...valid, ratings: { dimensions: [], min: 5, max: 1 } })),
    /ratings/u,
  );
  assert.throws(
    () => loadScenario(write('bad-task.json', { ...valid, task: { file: 'nope.md' } })),
    /task\.file/u,
  );
  assert.throws(
    () => loadScenario(join(dir, 'does-not-exist.json')),
    /cannot read\/parse/u,
  );
});

test('scenario: {{param}} expansion covers task + stages; unknown keys stay literal', () => {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-scenario-'));
  const p = join(dir, 'expand.json');
  writeFileSync(
    p,
    JSON.stringify({
      id: 'expand',
      title: '{{slug}} feature',
      task: 'Implement on {{branch}} with {{cols}} cols in {{max_time}}; also {{unknown_param}}.',
      stages: [
        {
          id: 's1',
          name: 'Stage {{slug}}',
          expect: ['{{branch}}'],
          ask_user: [{ titlePattern: '{{slug}}', answer: 'answer {{max_time}}' }],
        },
      ],
      timing: { startupTimeoutMs: 1, stageTimeoutMs: 2, checkpointPollMs: 3 },
      screenshots: { on: ['stage_start'] },
      ratings: { dimensions: ['message_clarity'], min: 1, max: 5 },
    }),
  );

  const scenario = loadScenario(p, { slug: 'login', branch: 'feat/login', cols: '120' });
  assert.equal(scenario.title, 'login feature');
  assert.equal(scenario.task, 'Implement on feat/login with 120 cols in 30m; also {{unknown_param}}.');
  assert.equal(scenario.stages[0]?.name, 'Stage login');
  assert.deepEqual(scenario.stages[0]?.expect, ['feat/login']);
  assert.equal(scenario.stages[0]?.ask_user?.[0]?.titlePattern, 'login');
  assert.equal(scenario.stages[0]?.ask_user?.[0]?.answer, 'answer 30m');
});

test('scenario: expandTemplate replaces known keys only', () => {
  assert.equal(expandTemplate('a {{slug}} b {{cols}}', { slug: 'x', cols: '1' }), 'a x b 1');
  assert.equal(expandTemplate('{{nope}}', {}), '{{nope}}');
  assert.equal(expandTemplate('{{ slug }}', { slug: 'y' }), 'y');
});

test('scenario: full-feature task expands with zero literal {{ (D3)', () => {
  // The full-feature reference scenario is the acceptance test for the
  // template expansion. Every {{key}} in the task template MUST resolve
  // — either from BUILTIN_DEFAULTS (feature_description, project_name,
  // platform_scope, max_time) or from the scenario's own params
  // (slug, branch, task). If any key is missing, the agent receives a
  // literal '{{...}}' string and silently ignores it.
  const scenario = loadScenario(FULL_FEATURE, { slug: 'my-feature', branch: 'feat/my-feature' });
  const literal = scenario.task.match(/\{\{[a-zA-Z0-9_]+\}\}/gu) ?? [];
  assert.deepEqual(literal, [], `full-feature task should not contain literal placeholders, found: ${literal.join(', ')}`);
  // And the same goes for the rendered title (uses {{slug}}).
  assert.ok(!scenario.title.includes('{{'), 'rendered title has no literal placeholders');
  // Every stage name must also expand cleanly.
  for (const stage of scenario.stages) {
    assert.ok(!stage.name.includes('{{'), `stage ${stage.id} name still has literal {{`);
  }
  // Smoke-check the actually-substituted values: feature_description /
  // project_name / platform_scope came from BUILTIN_DEFAULTS so they
  // are present in the rendered task text.
  assert.match(scenario.task, /my-feature/, '{{slug}} expanded');
  assert.match(scenario.task, /feat\/my-feature/, '{{branch}} expanded');
  assert.match(scenario.task, /30m/, '{{max_time}} expanded (BUILTIN_DEFAULTS)');
  assert.match(scenario.task, /the feature described in the task prompt/u, '{{feature_description}} from BUILTIN_DEFAULTS');
  assert.match(scenario.task, /ux-e2e-scratch/u, '{{project_name}} from BUILTIN_DEFAULTS');
});
