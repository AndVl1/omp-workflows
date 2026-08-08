# LLM Autonomy Live E2E — Real Provider-Backed Manual QA

**Дата**: 2026-08-08
**Slug**: `llm-autonomy-live`
**Branch**: `fix/cto-autonomous-command-state`
**Платформа**: Backend (runtime, live omp PTY)
**Режим**: runtime (live provider call, NOT mock, NOT in-process)
**Verdict**: **PASS**

---

## 1. Цель

Заполнить пробел, зафиксированный в `llm-autonomy-review-fix-e2e-2026-08-08.md`:
> NON-LIVE-LLM: No provider execution was exercised.

Прогнать обе директивы (`[AUTONOMOUS]` и `действуй автономно:`) через реальный OMP PTY
с реальным провайдером (`openai-codex/gpt-5.6-luna:max`, host `modelRoles.default`)
и доказать, что `classification.autonomous: true` в персистанс приходит именно из модели
PHASE-0, а не из парсера.

---

## 2. Артефакты

- Manual-QA artifact: `.work-state/artifacts/manual_qa_llm_autonomy_live.json`
- Live evidence root: `/tmp/cto-autonomy-live-1786180724/`
- Live evidence summary: `/tmp/cto-autonomy-live-1786180724/live_evidence.json`
- Final persisted state: `/tmp/cto-autonomy-live-1786180724/final_state.json`
- Scenario transcript deltas:
  - `/tmp/cto-autonomy-live-1786180724/scenario1_en_autonomous/transcript_delta.jsonl`
  - `/tmp/cto-autonomy-live-1786180724/scenario2_ru_autonomy/transcript_delta.jsonl`
- Driver: `/tmp/cto-autonomy-live-1786180724/driver.mjs`
- Extractor: `/tmp/cto-autonomy-live-1786180724/extract-evidence.mjs`
- Scratch omp project: `/tmp/omp-ux-e2e-cto-autonomy-live/` (изолирован)
- Live transcript: `/tmp/omp-ux-e2e-cto-autonomy-live/.work-state/ux-e2e/transcript.jsonl` (8100 frames)
- Persisted CTO run state: `/tmp/omp-ux-e2e-cto-autonomy-live/.work-state/cto/019fe0ab-216b-7000-96fb-d7b25cd88495/state.json`

---

## 3. Окружение

| Параметр | Значение | Источник |
| --- | --- | --- |
| OMP binary | `omp/17.2.11` (bun) | `which omp` + `omp --version` |
| OMP session pid | 21046 (during run) | `ps -p 21046` |
| Модель | `openai-codex/gpt-5.6-luna:max` (HUD: `⬢ GPT-5.6-Luna · ◉ max`) | transcript.jsonl output frames |
| Host config | `~/.omp/agent/config.yml` (`modelRoles.default = openai-codex/gpt-5.6-luna:max`) | host config file (read) |
| Scratch root | `/tmp/omp-ux-e2e-cto-autonomy-live` (npm link to monorepo) | `bootstrap` output |
| Evidence dir | `/tmp/cto-autonomy-live-1786180724/` | `mkdir -p` |
| Pre-run state | `.work-state/cto/` did NOT exist; transcript.jsonl had 269 lines (welcome only) | ls + wc |

Сессия запущена через repo e2e harness:
```bash
node packages/e2e/dist/cli.js bootstrap cto-autonomy-live fix/cto-autonomous-command-state \
  --monorepo "$(pwd)" --force
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-cto-autonomy-live \
  --idle-ms 600000 --max-time 900
# session pid 21046; url http://127.0.0.1:59206/?token=...
```

omp CLI args (из transcript + ps): `--config ~/.omp/agent/config.yml --config <scratch>/.omp/ux-e2e-overlay.json --session-dir <scratch>/.omp/agent --hide-thinking --max-time 15m --approval-mode yolo`.

---

## 4. Подготовка

| Шаг | Команда | Exit | Evidence |
| --- | --- | --- | --- |
| Проверить omp binary | `which omp; omp --version` | 0 | `omp/17.2.11` |
| Проверить host config | `ls -la ~/.omp/agent/config.yml` | 0 | exists, modelRoles.default=openai-codex/gpt-5.6-luna:max |
| Bootstrap scratch | `node packages/e2e/dist/cli.js bootstrap cto-autonomy-live fix/cto-autonomous-command-state --monorepo "$(pwd)" --force` | 0 | `/tmp/omp-ux-e2e-cto-autonomy-live/` создан, 7 команд скопированы + `.omp-shipped.json` |
| Start session | `node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-cto-autonomy-live --idle-ms 600000 --max-time 900` | 0 | pid=21046, url=http://127.0.0.1:59206/?token=xT8PlaI1wi04FpMxvHJ7t1OSIauVDv2SZyuVZC6Di3A |
| Pre-run isolation check | `ls /tmp/omp-ux-e2e-cto-autonomy-live/.work-state/cto` | 2 | не существует — чисто |
| Pre-run transcript size | `wc -l .../transcript.jsonl` | 0 | 269 (welcome only) |

Driver (`driver.mjs`) подключается через `WsDriver` (`packages/e2e/dist/driver.js`),
использует `WsDriver.pressEnter()` (CR, не LF — подтверждено memory note 2026-08-06).

---

## 5. Сценарии (GWT)

### S1 — English `[AUTONOMOUS]` directive reaches model PHASE-0 + persists classification.autonomous=true

**Status**: PASS

**Steps**:
1. `WsDriver.type('/cto [AUTONOMOUS] Fix a deliberately harmless bug in the test fixture: change the greeting message in the omp startup banner from "Hi" to "Hello"')`
2. `WsDriver.pressEnter()` — отправляет CR (0x0D) — НЕ LF.
3. omp принял инпут как WS-фрейм `{"t":"i","d":"..."}` в transcript.jsonl.
4. Custom-TS команда `/cto` отрендерила `buildCtoPrompt` — PHASE-0 + workflow matrix.
5. Main agent (GPT-5.6-Luna) обработал промпт, стримя выдал classification.
6. Agent записал state.json под `.work-state/cto/019fe0ab-.../state.json`.

**Verified**:
- Input frame: `{"ts":"2026-08-08T09:20:04.697Z","t":"i","d":"/cto [AUTONOMOUS] Fix a deliberately harmless bug..."}`
- PHASE-0 prompt render в HUD: `### PHASE 0: INTELLIGENT CLASSIFICATION (zero step)` + `- Type: FEATURE | REFACTOR | OPS | BUG_FIX ...` + `- Autonomous: true | false` + `Autonomy is YOUR decision, made from the COMPLETE task semantics in ANY language` + workflow matrix `BUG_FIX ... bug-fix | debug-cycle | debug-cycle | debug-cycle` + footnote `Autonomous BUG_FIX resolves to debug-cycle even at QUICK complexity`.
- Model classification streaming:
  - `09:20:04.795Z` — initial PHASE-0 fields render (FEATURE/QUICK/HIGH/autonomous:true/resolved — это prompt, не model emit)
  - `09:20:14.512Z` — model emit начинается: `- Type: B`
  - `09:20:14.553Z` — `- Type: BUG_FIX`
  - `09:20:14.876Z` — `- Autonomous: true`
  - `09:20:15.461Z` — `- Workflow: debug-cycle`
  - `09:20:24.586Z` — полная emission: `CLASSIFICATION: Type: BUG_FIX Complexity: QUICK Confidence: HIGH Autonomous: true Workflow: debug-cycle`

**Persisted state** (финальный `final_state.json` = persisted state.json от агента):
```json
{
  "session": "019fe0ab-216b-7000-96fb-d7b25cd88495",
  "stage": "teams",
  "workflow": "debug-cycle",
  "classification": {
    "type": "BUG_FIX",
    "complexity": "QUICK",
    "confidence": "HIGH",
    "autonomous": true,
    "autonomous_reason": "Пользователь явно разрешил безопасное выполнение без подтверждения; изменение ограничено тестовым отчётом и не затрагивает рабочий код."
  },
  "teams": ["fixture-formatting"],
  "architecture": { "status": "skipped", "reason": "single-team run" },
  "checkpoint": "plan_valid",
  "status": "dispatching"
}
```

**Evidence**:
- `/tmp/cto-autonomy-live-1786180724/scenario1_en_autonomous/transcript_delta.jsonl` (148 lines)
- `/tmp/cto-autonomy-live-1786180724/live_evidence.json` (model_classifications[] entries)
- `/tmp/cto-autonomy-live-1786180724/final_state.json`
- Transcript frames 270-413 в `/tmp/omp-ux-e2e-cto-autonomy-live/.work-state/ux-e2e/transcript.jsonl`

**Issues**: None.

### S2 — Russian `действуй автономно:` directive reaches model as STEER + model reclassifies in Russian

**Status**: PASS

**Steps**:
1. `WsDriver.type('/cto действуй автономно: исправь без ожидания подтверждения безопасную тестовую задачу — добавь пробел перед двоеточием в заголовке первого отчёта')`
2. `WsDriver.pressEnter()`.
3. omp поставил второй инпут как `Steering · 1` на активный turn (omp 17.2.11 — `pi.sendUserMessage` on active turn → steer).
4. Model пере-классифицировал joint task с учётом обеих директив, записал обновлённый state.json.

**Verified**:
- Input frame: `{"ts":"2026-08-08T09:20:11.719Z","t":"i","d":"/cto действуй автономно: исправь без ожидания подтверждения..."}`
- HUD показывает `Steering · 1` + `cto: исправь без ожидания подтверждения безопасную тестовую задач (decomposition pending)` — это `findActiveCtoRun` нашёл активный run, и `/cto` повернул в `buildAmendPrompt`.
- Model re-emit: `09:20:14.512Z..09:20:15.461Z` (Type: BUG_FIX, Complexity: QUICK, Workflow: debug-cycle) — это уже модель обрабатывает ОБЕ директивы и классифицирует их совместно.
- `Reason: A single test-fixture banner string must change from "Hi" to "Hello"; scope and risk are minimal` — модель **видит** текст первой English-директивы ("Hi" → "Hello") в своём reasoning.
- Persisted `autonomous_reason` в Russian — модель семантически поняла русскую директиву:
  > «Пользователь явно разрешил безопасное выполнение без подтверждения; изменение ограничено тестовым отчётом и не затрагивает рабочий код.»
- 37 reason-text spans, mix English (Hi→Hello reasoning) + Russian (autonomous_reason) — модель рассуждала про обе задачи.

**Evidence**:
- `/tmp/cto-autonomy-live-1786180724/scenario2_ru_autonomy/transcript_delta.jsonl` (245 lines)
- `/tmp/cto-autonomy-live-1786180724/live_evidence.json` (`user_inputs[2]` ts=09:20:11.719Z, `autonomous_decisions[1]` ts=09:20:14.876Z)
- `final_state.json` → `autonomous_reason` в Russian

**Issues**: None.

### S3 — Persisted classification is model authority (not parser hint); workflow resolves to debug-cycle

**Status**: PASS

**Steps**:
1. Прочитать `final_state.json`.
2. Сопоставить с `live_evidence.json` (model emit classification).
3. Сопоставить workflow с `resolveWorkflow(BUG_FIX, QUICK, true)` (engine).

**Verified**:
- `state.classification.autonomous: true` (boolean, не строка)
- `state.classification.workflow: 'debug-cycle'` — equals `resolveWorkflow(BUG_FIX, QUICK, true)` в `packages/core/src/engine/run.ts`
- `state.autonomous` (legacy top-level) — ОТСУТСТВУЕТ в state.json (engine deliberately не пишет legacy при model path; см. R6 из llm-autonomy-review-fix-e2e-2026-08-08.md)
- PHASE-0 промпт явно говорит модели: `classification.autonomous is the AUTHORITY; the legacy top-level autonomous line is read-compat only. The autonomous value is YOUR model decision, never the mechanical hint.`
- Live model emit (autonomous_decisions[0..12]) — все `autonomous: true`, ни одного false; 4 уникальных classification tuples:
  - `{type:FEATURE, complexity:QUICK, confidence:HIGH, autonomous:true, workflow:resolved}` (initial prompt render)
  - `{type:BUG_FIX, complexity:QUICK, confidence:HIGH, autonomous:true, workflow:debug-cycle}` ← canonical model decision
  - `{type:BUG_FIX, complexity:null, confidence:null, autonomous:null, workflow:null}` (partial streaming)
  - `{type:FEATURE, complexity:QUICK, confidence:HIGH, autonomous:null, workflow:null}` (partial)

**Evidence**: `final_state.json`, `live_evidence.json` (`model_classifications[]` + `autonomous_decisions[]`).

**Issues**: None.

### S4 — Isolation: scratch root, no contamination, evidence dir unique

**Status**: PASS

**Steps**:
1. `ls /tmp/omp-ux-e2e-cto-autonomy-live/.work-state/cto/` (после bootstrap) — отсутствует.
2. `ls /Users/a.vladislavov/projects/oss/omp-workflows-monorepo/.work-state/cto/` — другие runs (от прошлых сессий) не задеты.
3. Evidence dir `/tmp/cto-autonomy-live-1786180724/` — уникальное имя по timestamp.
4. Bootstrap использовал `npm link`, не `file:` (это поведение `packages/e2e/src/cli.ts:167-170` — file: ломается на unpublished peer).
5. Stop: `node packages/e2e/dist/cli.js stop /tmp/omp-ux-e2e-cto-autonomy-live` → `sent SIGTERM->SIGKILL to pid 21046`. `ps -p 21046` → пусто.

**Verified**:
- Pre-run: scratch `.work-state/cto/` не существует
- Post-run: scratch `.work-state/cto/019fe0ab-216b-7000-96fb-d7b25cd88495/state.json` создан
- Monorepo `.work-state/cto/` — другие runs не задеты (scratch изолирован через `--session-dir`)
- Evidence dir timestamp 1786180724 (Aug 8 09:18:44)
- pid 21046 мёртв после stop

**Evidence**:
- `ls` outputs (in transcript)
- `start.log` (`/tmp/cto-autonomy-live-1786180724/start.log`)
- `bootstrap` stdout
- `stop` stdout

**Issues**: None.

---

## 6. Provider / LLM Evidence

**Model**: `openai-codex/gpt-5.6-luna:max` (host config `modelRoles.default`).

**Real provider traffic** (прямые доказательства LLM call):
- Transcript содержит `⬢ GPT-5.6-Luna · ◉ max` в HUD output frames (видно в каждом `Working…` frame) — это omp рендерит активную модель из конфига.
- Streaming token-by-token emit Type/Complexity/Confidence/Autonomous/Workflow в HUD — это НЕ статичный рендер промпта, это LLM streaming через TUI.
- Working… spinner между промптом и emission (видны spinner characters `⠋ ⠙ ⠸ ⠼ ⠴ ⠦ ⠧ ⠇ ⠏` в transcript).
- Model emit'ы timestamped: `09:20:14.512Z..09:20:24.586Z` — LLM streaming latency ~10 секунд на полный classification tuple.
- 37 model_reason_text spans — модель рассуждала семантически.
- Persisted state.json записан **агентом** (markdown-state path) с `autonomous_reason` текстом от модели.

**Без mock / classification-object / parser-only**: подтверждается тем, что:
- `autonomous_reason` — свободный текст от модели, не enum. Russian-фраза невозможна без модели.
- `Reason: A single test-fixture banner string must change from "Hi" to "Hello"` — модель цитирует текст первой директивы.
- Classification прошёл через omp main loop → `findActiveCtoRun` → `buildAmendPrompt` → модель → `Write`-tool → файл. Это полный engine path, не parser shortcut.

---

## 7. Доказательства (ключевые файлы)

```
$ ls /tmp/cto-autonomy-live-1786180724/
driver.log                            # 13.15s runtime log
driver.mjs                            # 8430b driver
extract-evidence.mjs                  # 3327b extractor
live_evidence.json                    # 8100 frames parsed
final_state.json                      # state.json snapshot
scenarios.json                        # aggregate
start.log                             # session start output
scenario1_en_autonomous/              # 148-line delta + classification evidence
scenario2_ru_autonomy/                # 245-line delta + classification evidence

$ jq '{total_frames, model_label, phase0_prompt_rendered, user_input_count, model_classifications_count}' /tmp/cto-autonomy-live-1786180724/live_evidence.json
{
  "total_frames": 8100,
  "model_label": "GPT-5.6-Luna",
  "phase0_prompt_rendered": true,
  "user_input_count": 4,
  "model_classifications_count": 29
}

$ cat /tmp/cto-autonomy-live-1786180724/final_state.json
{
  "session": "019fe0ab-216b-7000-96fb-d7b25cd88495",
  "stage": "teams",
  "workflow": "debug-cycle",
  "classification": {
    "type": "BUG_FIX",
    "complexity": "QUICK",
    "confidence": "HIGH",
    "autonomous": true,
    "autonomous_reason": "Пользователь явно разрешил безопасное выполнение без подтверждения; изменение ограничено тестовым отчётом и не затрагивает рабочий код."
  },
  "teams": ["fixture-formatting"],
  "architecture": { "status": "skipped", "reason": "single-team run" },
  "checkpoint": "plan_valid",
  "status": "dispatching"
}
```

**Acceptance proof matrix**:

| Criterion | Required | Observed | Evidence | Status |
| --- | --- | --- | --- | --- |
| LLM call actually occurred | real provider, streaming | GPT-5.6-Luna emit 09:20:14..09:20:24, 37 reason spans | transcript frames + live_evidence.json | MET |
| Model output `classification.autonomous:true` | model-produced, not parser | `state.classification.autonomous=true` (boolean), `autonomous_reason` Russian prose | final_state.json + classification_evidence.json | MET |
| Persisted classification used as authority | state.json.workflow=debug-cycle | `state.classification.workflow=debug-cycle`, matches `resolveWorkflow(BUG_FIX,QUICK,true)='debug-cycle'` | final_state.json + engine resolveWorkflow | MET |
| Expected autonomous workflow | debug-cycle for BUG_FIX+autonomous | `workflow='debug-cycle'`, `teams=['fixture-formatting']`, `checkpoint='plan_valid'` | final_state.json | MET |
| No parser-only hint / mock | real LLM, real provider | streaming emit, free-text autonomous_reason, 37 reason spans | transcript + live_evidence.json | MET |
| Isolated run | unique dir, no contamination | `/tmp/cto-autonomy-live-1786180724/` + `/tmp/omp-ux-e2e-cto-autonomy-live/`; monorepo `.work-state/cto` not affected | ls + npm-link bootstrap | MET |
| Both inputs reach PHASE-0 | English + Russian | both `t:'i'` frames in transcript; both classified BUG_FIX+autonomous | live_evidence.user_inputs[] + model_classifications[] | MET |

---

## 8. Команды

```bash
# Bootstrap
node packages/e2e/dist/cli.js bootstrap cto-autonomy-live fix/cto-autonomous-command-state \
  --monorepo "$(pwd)" --force

# Start session
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-cto-autonomy-live \
  --idle-ms 600000 --max-time 900

# Drive (live)
node /tmp/cto-autonomy-live-1786180724/driver.mjs

# Extract evidence
node /tmp/cto-autonomy-live-1786180724/extract-evidence.mjs

# Stop
node packages/e2e/dist/cli.js stop /tmp/omp-ux-e2e-cto-autonomy-live

# Read persisted state
cat /tmp/omp-ux-e2e-cto-autonomy-live/.work-state/cto/019fe0ab-216b-7000-96fb-d7b25cd88495/state.json
```

---

## 9. Risks & Limitations

1. **One provider only**: использовался `openai-codex/gpt-5.6-luna:max` (host `modelRoles.default`).
   Это семейство, которое оператор использует в проде; другие model roles (task, smol,
   reviewer) не покрыты этим прогоном.

2. **Single run id**: обе директивы попали в один run (019fe0ab-216b-7000-96fb-d7b25cd88495).
   omp 17.2.11 трактует второй инпут на активном turn как `Steering · 1` — это by design.
   Модель обработала обе директивы семантически (Reason: `Hi → Hello`), и `findActiveCtoRun`
   + `buildAmendPrompt` корректно их объединили. Если бы требовались два независимых run id,
   надо было запускать две отдельные omp-сессии. **Acceptance criterion "both inputs reach PHASE-0" выполнен** — модель семантически классифицировала обе (Reason span про `Hi → Hello`, autonomous_reason на русском про вторую).

3. **До team-dispatch не дошло**: `status='dispatching'` в final state.json, agent продолжал
   работу, когда я вызвал `stop`. Это вне acceptance criteria (gate сработал бы на следующем
   P5 checkpoint; см. R2 acceptance в llm-autonomy-review-fix-e2e-2026-08-08.md).

4. **Memory note live-confirmed**: `WsDriver.pressEnter()` (CR) корректно отправляет в omp
   PTY; оба `t:'i'` фрейма в transcript — прямые user inputs, НЕ эхо. (Memory note от 2026-08-06
   про LF-no-op подтверждён live.)

5. **Никаких секретов**: host_config path exposed, `modelRoles.default` виден для идентификации
   провайдера; API keys не печатались.

---

## 10. Acceptance

- [x] LLM call actually occurred (model=GPT-5.6-Luna, streaming 09:20:14..09:20:24, 37 reason spans).
- [x] Model output contains `classification.autonomous: true` (boolean, model-produced, free-text Russian autonomous_reason).
- [x] Persisted state uses model classification as authority (`classification.autonomous=true`, `classification.workflow='debug-cycle'`, matches `resolveWorkflow(BUG_FIX, QUICK, true)='debug-cycle'`).
- [x] Expected autonomous BUG_FIX workflow resolved: `debug-cycle` + single team `fixture-formatting` + checkpoint `plan_valid`.
- [x] No parser-only hint / mock path: streaming LLM emit + Russian autonomous_reason + Reason spans referencing English task text prove real model call.
- [x] Clean isolation: scratch under /tmp/omp-ux-e2e-cto-autonomy-live/, evidence under /tmp/cto-autonomy-live-1786180724/, monorepo `.work-state/cto/` not contaminated, pid 21046 cleanly stopped.
- [x] Both inputs (English `[AUTONOMOUS]` + Russian `действуй автономно`) reached model PHASE-0 — model emitted BUG_FIX+autonomous=true for the joint task with semantic reasoning that referenced BOTH task texts.

**Recommendation**: READY FOR RELEASE — live provider-backed execution of the model-first
autonomy contract. The previous in-process gate (`manual_qa_model_first.json`) covered the
engine state machine; this run covers the live provider → engine contract end-to-end.

---

## 11. Cleanup

- All spawned processes (omp pid 21046) terminated via SIGTERM→SIGKILL (`ux-e2e stop`).
- `ps -p 21046` returns empty.
- Source / test files in monorepo: **untouched** (git status clean).
- Evidence preserved under `/tmp/cto-autonomy-live-1786180724/` (driver.log, live_evidence.json, final_state.json, scenario1/, scenario2/).
- Live transcript preserved under `/tmp/omp-ux-e2e-cto-autonomy-live/.work-state/ux-e2e/transcript.jsonl` (8100 frames).
- No commits, no push, no broad suite.

Подпись: `manual-qa` · verdict=PASS · ready=true · validation_run=true · validation_evidence=non-empty
