# Registered run-lifecycle journey

Эта задача — операторский checklist для одной manifest-backed live-сессии, а не
prompt для модели. Все команды `/do-work` вводи отдельными запросами через
`e2e:input`; не передавай checklist или JSON-сценарий как одну задачу. Каждый
видимый `workflow_prepare` receipt сохраняй в transcript.

## Prepare the run

Работай из корня monorepo и используй один manifest на весь journey. `prepare`
создаёт изолированный workspace и evidence под `OMP_E2E_ROOT`; подготовленная
ветка называется `e2e/<run-id>` (для этого journey — `e2e/run-lifecycle-journey`).
Не ожидай старого feature-префикса: другой branch name допустим только если ты
явно переименовал ветку в run-owned workspace.

```bash
export OMP_E2E_ROOT="${OMP_E2E_ROOT:-${TMPDIR:-/tmp}/omp-workflows-e2e}"
RUN_ID="run-lifecycle-journey"
MANIFEST="$OMP_E2E_ROOT/runs/$RUN_ID/manifest.json"
WORKSPACE="$OMP_E2E_ROOT/runs/$RUN_ID/workspace"
EVIDENCE="$OMP_E2E_ROOT/runs/$RUN_ID/evidence"

npm run e2e:prepare -- \
  --config packages/e2e/scenarios/live-smoke.env.json \
  --run "$RUN_ID" --json
npm run e2e:auth-broker -- ensure --manifest "$MANIFEST" --json
npm run e2e:doctor -- --manifest "$MANIFEST" --json
```

`live-smoke.env.json` explicitly opts into the installed omp OpenAI Codex
native host broker. `auth-broker ensure` is required for this provider-backed
journey; there is no implicit host configuration or credential copy. Keep
`WORKSPACE` and `EVIDENCE` run-owned, and never put credentials in commands,
transcripts, reports, or exported evidence.

Start the named session and, in another terminal, follow its redacted
transcript while driving it:

```bash
npm run e2e:start -- --manifest "$MANIFEST" --session-id journey \
  --surface text --detach --json
npm run e2e:transcript -- --manifest "$MANIFEST" --session-id journey --follow
```

Stop the `transcript --follow` command with Ctrl-C only; that does not stop the
omp session. For every pending `[ask_user]` prompt, inspect and answer it only
through the registered ask flow:

```bash
npm run e2e:ask -- --manifest "$MANIFEST" --session-id journey --list --json
npm run e2e:ask -- --manifest "$MANIFEST" --session-id journey \
  --answer "<the displayed option>" --json
```

## A → B → C → A

1. On the prepared `e2e/run-lifecycle-journey` branch, create A and drive it
   to a quiescent or terminal point:

   ```bash
   npm run e2e:input -- --manifest "$MANIFEST" --session-id journey \
     --text '/do-work --new "Экспорт отчётов A"' --json
   ```

   The receipt must show `operation: new`, the selected run, and its
   continuation point. Use `e2e:transcript` (and `e2e:ask` if needed) after
   each dispatch so the receipt is visible before continuing.

2. On that same prepared branch, create B:

   ```bash
   npm run e2e:input -- --manifest "$MANIFEST" --session-id journey \
     --text '/do-work --new "Экспорт отчётов B"' --json
   ```

   The receipt must show A detached with saved progress and B created and
   selected. Similar titles on one branch must not silently select A.

3. Change only the Git context of the run-owned workspace to a new, truthful
   branch, then create C. This is the one host-side Git operation in the
   journey; it must target `"$WORKSPACE"`, never another project:

   ```bash
   git -C "$WORKSPACE" switch -c "e2e/${RUN_ID}-c"
   npm run e2e:input -- --manifest "$MANIFEST" --session-id journey \
     --text '/do-work --new "Экспорт отчётов C"' --json
   ```

   The receipt must show the `e2e/${RUN_ID}-c` branch, a newly selected C, and
   no state copied from A or B.

4. Return to A's original branch and request the list through the named
   session:

   ```bash
   git -C "$WORKSPACE" switch "e2e/${RUN_ID}"
   npm run e2e:input -- --manifest "$MANIFEST" --session-id journey \
     --text '/do-work --list' --json
   ```

   Check the visible title, branch, status, and stage. If more than one run is
   eligible, choose the number/title from this exact list in a new
   `e2e:input` request; do not enter a UUID or assume ordering after the
   catalog changes. Until an item is selected, expect no lifecycle mutation.

5. With A selected by that displayed item, request rework in natural language
   (or use the registered `--rework` mode with feedback, never a run selector):

   ```bash
   npm run e2e:input -- --manifest "$MANIFEST" --session-id journey \
     --text '/do-work доработай "Экспорт отчётов A": уточни результат и сохрани новую итерацию' \
     --json
   ```

   The receipt must show `operation: rework`, an immutable revision/evidence
   snapshot, a new continuation point, and the new rework generation. An old
   downstream receipt must not close this new iteration.

At every refusal, record the typed code and confirm that no transition
occurred. In particular, `run_busy`, `run_context_mismatch`,
`run_selection_required`, and `run_not_found` are refusals, not PASS. Do not
repair canonical state by hand or call core APIs directly.

## Stop, report, and clean up

After the final receipt, stop and report the named session, then clean only this
manifest's run-owned resources. `report --copy-evidence` writes sanitized
copies under the run-owned `$EVIDENCE/markdown/evidence/` directory; the report
JSON is under `$EVIDENCE/journey/report.json`.

```bash
npm run e2e:transcript -- --manifest "$MANIFEST" --session-id journey \
  --tail 200 --json
npm run e2e:stop -- --manifest "$MANIFEST" --session-id journey --json
npm run e2e:report -- --manifest "$MANIFEST" --session-id journey \
  --md-dir "$EVIDENCE/markdown" --copy-evidence --json
npm run e2e:cleanup -- --manifest "$MANIFEST" --json
```

Inspect the redacted report and transcript as evidence of the observed journey;
neither package tests nor scenario metadata alone is proof of a live pass.
