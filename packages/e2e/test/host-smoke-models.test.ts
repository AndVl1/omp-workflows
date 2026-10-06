import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildHostModelPlan, requireConcreteModelSelector } from '../src/host-smoke-models.js';

test('host role config adds and deduplicates an agent alias missing from built-ins', () => {
  const model = 'provider/model';
  const plan = buildHostModelPlan(model, ['default', 'task'], [
    { name: 'domain-lead', patterns: [
      { selector: '@domain-lead', role: 'domain-lead' },
      { selector: '@task', role: 'task' },
    ] },
    { name: 'new-agent', patterns: [
      { selector: '@domain-lead', role: 'domain-lead' },
      { selector: '@task', role: 'task' },
    ] },
  ]);

  assert.deepEqual(plan.config.modelRoles, {
    default: model,
    task: model,
    'domain-lead': model,
  });
});

test('host model selector rejects role indirection, fallback lists, and SDK glob selectors', () => {
  for (const selector of [
    '@slow', '*', 'pi/domain-lead', 'domain-lead', '/model', 'provider/',
    'provider/model,other/model', 'provider/*', 'provider/model?', 'provider/[ab]',
  ]) {
    assert.throws(() => requireConcreteModelSelector(selector), /concrete provider\/model selector/u, selector);
  }
});
