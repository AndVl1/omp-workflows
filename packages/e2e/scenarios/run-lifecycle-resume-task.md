# Fresh-session resume and guards

Это операторский checklist для двух чистых manifest-backed сессий. Он не
является prompt модели: вводи каждую `/do-work` команду отдельным запросом
через `e2e:input`, а каждый видимый receipt сохраняй в transcript. Не клади
credentials в config, команды, transcript, report или exported evidence.

## Prepare and start Session 1

Из корня monorepo подготовь отдельный run. Все пути ниже принадлежат этому
run; подготовленная Git-ветка называется `e2e/<run-id>`, здесь
`e2e/run-lifecycle-resume`, а не старое feature-имя.

```bash
export OMP_E2E_ROOT="${OMP_E2E_ROOT:-${TMPDIR:-/tmp}/omp-workflows-e2e}"
RUN_ID="run-lifecycle-resume"
MANIFEST="$OMP_E2E_ROOT/runs/$RUN_ID/manifest.json"
WORKSPACE="$OMP_E2E_ROOT/runs/$RUN_ID/workspace"
EVIDENCE="$OMP_E2E_ROOT/runs/$RUN_ID/evidence"

npm run e2e:prepare -- \
  --config packages/e2e/scenarios/live-smoke.env.json \
  --run "$RUN_ID" --json
npm run e2e:auth-broker -- ensure --manifest "$MANIFEST" --json
npm run e2e:doctor -- --manifest "$MANIFEST" --json
npm run e2e:start -- --manifest "$MANIFEST" --session-id resume-1 \
  --surface text --detach --json
```

`live-smoke.env.json` is an explicit opt-in to the installed omp OpenAI Codex
native host broker. The broker is not implicit, and the harness must not copy
the host auth database or refresh token into this run. Keep the named
`WORKSPACE` and `EVIDENCE` paths run-owned.

In another terminal follow the redacted transcript while driving Session 1:

```bash
npm run e2e:transcript -- --manifest "$MANIFEST" --session-id resume-1 --follow
```

If the workflow presents `[ask_user]`, inspect and answer it only with the
registered ask command, never by editing state:

```bash
npm run e2e:ask -- --manifest "$MANIFEST" --session-id resume-1 --list --json
npm run e2e:ask -- --manifest "$MANIFEST" --session-id resume-1 \
  --answer "<the displayed option>" --json
```

## Session 1: save and close

1. Create the first run and drive it to the point where its decision and
   required inputs are durably saved in canonical artifacts/evidence:

   ```bash
   npm run e2e:input -- --manifest "$MANIFEST" --session-id resume-1 \
     --text '/do-work --new "Решение для отчётов"' --json
   ```

   Keep the `workflow_prepare` receipt and the decision/checkpoint plus saved
   artifact/evidence receipt in the transcript. Stop the transcript follower
   with Ctrl-C when you have captured the boundary; this does not stop omp.

2. Stop Session 1 explicitly, then make its redacted report. Its JSON report
   is under `$EVIDENCE/resume-1/`; copied evidence is under
   `$EVIDENCE/markdown/resume-1/evidence/`:

   ```bash
   npm run e2e:stop -- --manifest "$MANIFEST" \
     --session-id resume-1 --json
   npm run e2e:report -- --manifest "$MANIFEST" \
     --session-id resume-1 --md-dir "$EVIDENCE/markdown/resume-1" \
     --copy-evidence --json
   ```

   Do not pass a previous chat, UUID, or an external workspace to the next
   session. The run-owned workspace and canonical state remain in
   `$WORKSPACE`; Session 1's transcript and report remain separate from
   Session 2's.

## Session 2: resume without the old chat

Start a fresh named session against the same manifest:

```bash
npm run e2e:doctor -- --manifest "$MANIFEST" --json
npm run e2e:start -- --manifest "$MANIFEST" --session-id resume-2 \
  --surface text --detach --json
npm run e2e:transcript -- --manifest "$MANIFEST" --session-id resume-2 --follow
```

3. Without sending Session 1's chat or a UUID, request continuation by title:

   ```bash
   npm run e2e:input -- --manifest "$MANIFEST" --session-id resume-2 \
     --text '/do-work продолжи фичу' --json
   ```

   When candidates are shown, select a title/list item through the registered
   selector flow and only then accept the receipt. It must show
   `operation: resume`, restored stage/cursor/decision, and required-artifact
   reads before the next dispatch. Completed stages must not run again.

4. Create a second unfinished run with the same readable title, then request a
   fresh list. Keep the selection read-only until an item from that exact
   displayed list is chosen:

   ```bash
   npm run e2e:input -- --manifest "$MANIFEST" --session-id resume-2 \
     --text '/do-work --new "Решение для отчётов"' --json
   npm run e2e:input -- --manifest "$MANIFEST" --session-id resume-2 \
     --text '/do-work --list' --json
   ```

   The list must show distinguishable branch/status/stage entries. Choose the
   displayed number/title in a subsequent `e2e:input` request, never a UUID.
   Adding the new run must not silently retarget the old list item; a stale or
   ambiguous selection is a refusal without mutation.

5. For recovery, use only the bounded missing-input fixture prepared by the
   workflow itself; do not delete, forge, or hand-edit canonical state. Once
   that fixture is selected, issue the registered resume request:

   ```bash
   npm run e2e:input -- --manifest "$MANIFEST" --session-id resume-2 \
     --text '/do-work --resume' --json
   ```

   Expect `recovery_required`, the missing evidence name, and refusal of the
   dependent transition. A fabricated summary is not evidence.

6. If the transcript exposes a persisted pending dispatch, request resume
   again through the same named session:

   ```bash
   npm run e2e:input -- --manifest "$MANIFEST" --session-id resume-2 \
     --text '/do-work продолжи фичу' --json
   ```

   The receipt must preserve the same dispatch identity and report `pending`,
   `background_wait`, or `transport_reconnect`; no new worker may be created.

7. After terminal A, start an ordinary new task and verify it is `operation:
   new`, not a continuation constrained by A's history:

   ```bash
   npm run e2e:input -- --manifest "$MANIFEST" --session-id resume-2 \
     --text '/do-work --new "Обычная новая задача после A"' --json
   ```

   The new task must not inherit A's DoD, classification, or monotonic gates.

Every step must be confirmed by the visible named-session transcript. Record
each typed refusal as a refusal without transition, including
`run_selection_required`, `run_busy`, `recovery_required`, and `run_terminal`;
none is PASS.

## Stop, report, and clean up

Capture the final redacted transcript, stop Session 2, report it under the
run-owned evidence root, and clean the run:

```bash
npm run e2e:transcript -- --manifest "$MANIFEST" --session-id resume-2 \
  --tail 300 --json
npm run e2e:stop -- --manifest "$MANIFEST" \
  --session-id resume-2 --json
npm run e2e:report -- --manifest "$MANIFEST" \
  --session-id resume-2 --md-dir "$EVIDENCE/markdown/resume-2" \
  --copy-evidence --json
npm run e2e:cleanup -- --manifest "$MANIFEST" --json
```

The JSON reports live under `$EVIDENCE/resume-1/` and
`$EVIDENCE/resume-2/`, with distinct transcripts and Markdown evidence.
Cleanup may remove private run resources but copied redacted evidence remains.
Do not treat package tests or scenario metadata as proof of the live resume
journey.
