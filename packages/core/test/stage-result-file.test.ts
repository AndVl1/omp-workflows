import assert from 'node:assert/strict';
import test from 'node:test';
import { writeFileSync, symlinkSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ordinaryHarness, ordinaryIngress, admitOrdinaryWorker, ctoHarness, ctoIngress, admitCtoLeadAndWorker, requireTool, details, implementationOutput, terminalWorker, sessionManager } from './reliable-stage-execution-fixture.js';
import { readRunState } from '../src/engine/run-store.js';
import { readCtoState } from '../src/cto/state.js';

for (const route of ['ordinary', 'cto'] as const) {
  test(`${route}: file delivery preserves receipts, inline replay and immutable publication`, async () => {
    const h = route === 'ordinary' ? ordinaryHarness() : ctoHarness();
    try {
      const ingress = route === 'ordinary' ? await ordinaryIngress(h) : await ctoIngress(h);
      const worker = route === 'ordinary' ? await admitOrdinaryWorker(h, (ingress as Awaited<ReturnType<typeof ordinaryIngress>>).handoff, 'file') : await admitCtoLeadAndWorker(h, ingress.runId);
      const tool = requireTool(h, 'workflow_submit_result');
      const payload = { outputs: { implementation: implementationOutput() } };
      const path = join(h.root, 'stage-output.json');
      writeFileSync(path, JSON.stringify(payload));
      const call = async (input: unknown, ctx = worker.childContext) => details((await tool.execute('file-submit', input, undefined, undefined, ctx)).details);
      const accepted = await call({ outputs_path: 'stage-output.json' });
      assert.equal(accepted.ok, true, JSON.stringify(accepted));
      const receipt = details(accepted.receipt);
      const state = route === 'ordinary' ? readRunState(h.root, ingress.runId) : readCtoState(ingress.runId, h.root);
      const dispatchId = String(details(details(receipt.binding).identity).dispatch_id);
      assert.equal(state?.stage_receipts?.[dispatchId]?.receipt_id, receipt.receipt_id);
      const inline = await call(payload);
      assert.equal(inline.ok, true, JSON.stringify(inline));
      assert.equal(details(inline.receipt).receipt_id, receipt.receipt_id);
      writeFileSync(path, JSON.stringify({ outputs: { implementation: implementationOutput({ files_touched: ['different.ts'] }) } }));
      assert.equal((await call({ outputs_path: 'stage-output.json' })).ok, false);
      writeFileSync(path, JSON.stringify(payload));
      await terminalWorker(h, worker);
      const replay = await call({ outputs_path: 'stage-output.json' });
      assert.equal(replay.ok, true, JSON.stringify(replay));
      assert.equal(details(replay.receipt).receipt_id, receipt.receipt_id);
      const cold = route === 'ordinary' ? ordinaryHarness({ root: h.root }) : ctoHarness({ root: h.root });
      try {
        await cold.emit('session_start', { type: 'session_start' }, cold.context);
        const freshContext = { ...worker.childContext, sessionManager: sessionManager(h.root, worker.childContext.session_id, worker.childFile, worker.childContext.sessionManager.getHeader().parentSession) };
        const before = JSON.stringify(route === 'ordinary' ? readRunState(h.root, ingress.runId) : readCtoState(ingress.runId, h.root));
        const coldResult = details((await requireTool(cold, 'workflow_submit_result').execute('cold-file-replay', { outputs_path: 'stage-output.json' }, undefined, undefined, freshContext)).details);
        assert.equal(coldResult.ok, true, JSON.stringify(coldResult));
        assert.deepEqual(coldResult.receipt, accepted.receipt);
        assert.equal(JSON.stringify(route === 'ordinary' ? readRunState(h.root, ingress.runId) : readCtoState(ingress.runId, h.root)), before);
        writeFileSync(path, JSON.stringify({ outputs: { implementation: implementationOutput({ files_touched: ['cold-change.ts'] }) } }));
        const changed = details((await requireTool(cold, 'workflow_submit_result').execute('cold-changed-file', { outputs_path: 'stage-output.json' }, undefined, undefined, freshContext)).details);
        assert.equal(changed.ok, false, JSON.stringify(changed));
        assert.equal(JSON.stringify(route === 'ordinary' ? readRunState(h.root, ingress.runId) : readCtoState(ingress.runId, h.root)), before);
        writeFileSync(path, JSON.stringify(payload));
        const foreignFile = join(h.root, 'cold-foreign.jsonl');
        const foreign = { ...freshContext, session_id: 'cold-foreign', sessionFile: foreignFile, sessionManager: sessionManager(h.root, 'cold-foreign', foreignFile, h.context.sessionFile) };
        const denied = details((await requireTool(cold, 'workflow_submit_result').execute('cold-foreign-file', { outputs_path: 'missing.json' }, undefined, undefined, foreign)).details);
        assert.equal(denied.ok, false);
        assert.notEqual(denied.code, 'submission_file_unreadable');
        assert.equal(JSON.stringify(route === 'ordinary' ? readRunState(h.root, ingress.runId) : readCtoState(ingress.runId, h.root)), before);
      } finally { await cold.close(); }
    } finally { await h.close(); }
  });
  test(`${route}: invalid delivery never creates receipt and corrected JSON can submit`, async () => {
    const h = route === 'ordinary' ? ordinaryHarness() : ctoHarness();
    const outside = mkdtempSync(join(tmpdir(), 'submission-outside-'));
    try {
      const ingress = route === 'ordinary' ? await ordinaryIngress(h) : await ctoIngress(h);
      const worker = route === 'ordinary' ? await admitOrdinaryWorker(h, (ingress as Awaited<ReturnType<typeof ordinaryIngress>>).handoff, 'reject-file') : await admitCtoLeadAndWorker(h, ingress.runId);
      const tool = requireTool(h, 'workflow_submit_result');
      const call = async (input: unknown, ctx = worker.childContext) => details((await tool.execute('file-reject', input, undefined, undefined, ctx)).details);
      const noReceipt = () => {
        const state = route === 'ordinary' ? readRunState(h.root, ingress.runId) : readCtoState(ingress.runId, h.root);
        assert.equal(Object.values(state?.stage_receipts ?? {}).some((receipt) => (receipt.binding as { host?: { session_id?: string } } | undefined)?.host?.session_id === worker.childContext.session_id), false);
      };
      writeFileSync(join(outside, 'output.json'), JSON.stringify({ outputs: { implementation: implementationOutput() } }));
      symlinkSync(outside, join(h.root, 'escape'));
      symlinkSync(join(outside, 'output.json'), join(h.root, 'escape.json'));
      for (const input of [{}, { outputs: {}, outputs_path: 'stage-output.json' }, { outputs_path: join(outside, 'output.json') }, { outputs_path: '../output.json' }, { outputs_path: 'escape/output.json' }, { outputs_path: 'escape.json' }, { outputs_path: 'missing.json' }]) {
        const rejected = await call(input);
        assert.equal(rejected.ok, false, JSON.stringify(rejected));
        assert.equal(rejected.field_errors, undefined);
        noReceipt();
      }
      const file = join(h.root, 'stage-output.json');
      writeFileSync(file, '{"outputs":{"implementation":{}}');
      const parse = await call({ outputs_path: 'stage-output.json' });
      assert.equal(parse.code, 'invalid_submission_json');
      assert.equal(parse.field_errors, undefined);
      noReceipt();
      for (const envelope of [{ implementation: implementationOutput() }, { outputs: {}, run_id: ingress.runId }, { outputs: [] }]) {
        writeFileSync(file, JSON.stringify(envelope));
        const rejected = await call({ outputs_path: 'stage-output.json' });
        assert.equal(rejected.code, 'invalid_submission');
        assert.equal(rejected.field_errors, undefined);
        noReceipt();
      }
      writeFileSync(file, JSON.stringify({ outputs: { implementation: { ready: 'wrong' } } }));
      const schema = await call({ outputs_path: 'stage-output.json' });
      assert.equal(schema.code, 'invalid_outputs', JSON.stringify(schema));
      assert.ok(Array.isArray(schema.field_errors));
      assert.ok(schema.field_errors.some((e: { field: string }) => e.field.startsWith('outputs.implementation')));
      noReceipt();
      writeFileSync(file, JSON.stringify({ outputs: { implementation: implementationOutput() } }));
      const foreignFile = join(h.root, 'foreign.jsonl');
      const foreign = { ...worker.childContext, session_id: 'foreign', sessionFile: foreignFile, sessionManager: sessionManager(h.root, 'foreign', foreignFile, h.context.sessionFile) };
      assert.equal((await call({ outputs_path: 'stage-output.json' }, foreign)).ok, false);
      noReceipt();
      const mismatch = { ...worker.childContext, cwd: outside, sessionManager: sessionManager(outside, worker.childContext.session_id, worker.childFile, h.context.sessionFile) };
      assert.equal((await call({ outputs_path: 'output.json' }, mismatch)).ok, false);
      noReceipt();
      const corrected = await call({ outputs_path: 'stage-output.json' });
      assert.equal(corrected.ok, true, JSON.stringify(corrected));
      await terminalWorker(h, worker);
    } finally { await h.close(); rmSync(outside, { recursive: true, force: true }); }
  });
}
