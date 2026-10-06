# Host admission PR #72: ручная live-приёмка

## Итог

**Приёмка не зелёная: 5 PASS, 2 FAIL, 2 BLOCKED.** Утверждать «ничего не ломаем» по этому прогону нельзя.

Сценарии: [операторский checklist](../packages/e2e/scenarios/host-admission-task.md), [stage manifest](../packages/e2e/scenarios/host-admission.json). Проверялись реальные OMP PTY-сессии и зарегистрированные tools; unit-тесты и прямые вызовы simulated hooks не заменяли live-прогон.

Два end-to-end сбоя зафиксированы отдельно: `br-3so` — producer artifact contract в ordinary workflow; `br-asz` — выбор ordinary workflow tools в CTO-сценарии. **Связь этих сбоев с изменениями admission в PR #72 не установлена.** Наблюдавшиеся отказы соответствуют действующим защитным контрактам; ради PASS gates не ослаблялись и canonical state вручную не продвигался.

## Проверенная среда

- Код: ветка `fix/host-admission-diagnostics`, commit `4506b8e`; production-код во время этой приёмки не менялся.
- OMP `18.3.4`, Node `v26.8.1`.
- Локальные собранные core/fullstack `0.29.0`, internal `0.0.0`.
- Actual main/worker models: `openai-codex/gpt-6-luna`; для A7/A8 — `openai-codex/gpt-5.6-luna`. Модели подтверждались PTY/session evidence, а не только настройкой overlay. Для проверенного ordinary worker зафиксирован `resolvedModelIsFallback=false`.
- Нейтральные scratch Git roots, один workflow owner на сессию; отдельные roots для fullstack, internal и отрицательных fixtures. Main закреплялся явным `--model` и `--no-prewalk`, aliases — scratch-local overlay.
- OMP `18.4.2` с внешним `omp-workflows-vk-android@0.4.5` из issue #71 **не проверялся**. Этот отчёт не закрывает внешний compatibility case.

В raw logs также встречается ambient HTTP 401 от auto-thinking provider `~typesafe/jev-latest`. Это не модель main/worker; реальное выполнение Luna и tool results зафиксированы отдельно.

## Матрица

| Сценарий | Вердикт | Наблюдение |
|---|---|---|
| A1: idle host `bash/write/edit` | PASS | Реальный `git status`; `write` и `edit` дали точные байты `before` → `after`. Workflow для этих операций не создавался. Первые неточные ответы модели сохранены в evidence, не засчитаны за успешную запись. |
| A2: ordinary workflow + native worker + terminal | **FAIL** | Настоящий `frontend-developer` worker на Luna реализовал `sum` и успешно выполнил проверки. Затем `workflow_complete` отклонил невалидную форму `implementation.json`; terminal не достигнут. |
| A3: postterminal tools и clean restart | **BLOCKED** | Предусловие A2 — подтверждённый terminal — не наступило. Старые промежуточные перезапуски не выдаются за postterminal coverage. |
| A4: CTO positive и неавторизованный marker | **FAIL** positive; PASS negative | Authenticated CTO run/claim и active wave созданы через штатные tools. Естественно завершившийся resume turn выбрал ordinary workflow tools с CTO slug; worker и terminal отсутствуют. Отдельный неавторизованный marker отклонён до dispatch. |
| A5: неполная регистрация bundle | PASS с UI-ограничением | Реальный loader выбросил `workflow_registration:missing_actor_resolver` до регистрации label/hooks/tools/commands. Полный genuine exception содержит callback и действие; TUI startup line обрезает текст. |
| A6: ошибки resolver/cwd и structured denial | PASS | Восемь изолированных fixture-режимов прошли через настоящий `write`: правильные коды, Action/Report, отсутствие sentinel-файлов. Это diagnostic transport coverage, не genuine foreign-host isolation. |
| A7: настоящий foreign/unknown host context | **BLOCKED** | Через официальный публичный surface не найден поддерживаемый способ подать настоящий foreign session-manager context. Tool arguments и искусственный context не засчитаны за такое доказательство. |
| A8: повреждённый selected run | PASS | После real `/do-work --new` и prepare/instructions disposable state повреждён намеренно. Настоящие `bash/write` получили `workflow_state_recovery_required`; повреждённые байты и run-control не изменились, артефакт не создан. |
| A9: internal marked/unmarked activation | PASS | Marked fixture: internal owner и обычные tools работают. Unmarked: `activation_markers_missing`, owners unclaimed, обычные `bash/write/edit` не блокируются. |

## A2: успешный worker не означает успешный workflow

Финальный A2 запущен в чистом `/tmp/omp-ux-e2e-pr72-workflow-final-20260928`. До первого input были настроены public scope `frontend`, агент `frontend-developer`, конкретные `workflow_prepare.files`, полный Luna overlay и pristine package baseline commit `ba1aa6e`. Этот цикл не прерывался оператором.

Наблюдалось:

1. Реальный native worker `ImplementSumFeature` на Luna создал `src/sum.ts` и `scripts/check-sum.mjs`.
2. `npm run check:sum` сообщил успех для положительных, отрицательных и разноимённых аргументов; worker также записал успешную TypeScript-проверку.
3. Declared canonical `implementation.json` существует и читается.
4. Его единственный top-level key — `implementation`. Объявленный контракт требует **непосредственно** `files_touched`, `ready`, `validation_run`, `validation_evidence`.
5. `workflow_complete` вернул `WORKFLOW_COMPLETE_REJECTED: declared artifact missing or unsafe`; run остался на implementation.

Буквальное отсутствие файла исключено. Невалидная обёртка не соответствует producer schema; существующий файл нельзя засчитать за зарегистрированный валидный artifact. Ни worker output, ни его проверка функции не доказывают завершение workflow.

Задача `br-3so`: разобраться с передачей/исполнением producer schema и проверкой перед join, не принимать произвольные wrapped payloads автоматически и не ослаблять gate. После исправления нужны повторные A2 и A3.

## A4: CTO не дошёл до native dispatch

В `/tmp/omp-ux-e2e-pr72-cto-main` штатный `/cto` создал точный run и authenticated claim. После одной явной корректировки формы candidate модель выполнила допустимый `cto_state` commit active wave; canonical state не редактировался через файловые tools.

Для продолжения использован поддерживаемый `/cto --run <exact-id>`; parser и фактический `/cto AMEND` prompt проверены. Естественно завершившийся turn снова вызвал `workflow_instructions`/`workflow_status` с CTO slug. Ordinary resolver закономерно вернул `migration_required: canonical run selector requires a UUID run id`; вызов без selector вернул `no_active_run`. Модель сообщила об отсутствии worker dispatch и завершения.

Это **не доказательство регрессии native admission**: положительный CTO worker вообще не был запущен. Но end-to-end критерий пользователя не выполнен. Задача `br-asz` фиксирует необходимость исследовать этот выбор инструментов и довести реальный CTO путь до worker/terminal.

Отдельный negative case использовал публичный `omp-cto-slice` marker без authenticated claim. Получен `workflow_admission:cto_marker_unauthenticated`; worker, CTO state и claim не созданы. Это самостоятельный PASS, не замена positive case.

## Отрицательные проверки и границы доказательств

### A5: реальный loader, а не напечатанный expected message

Incomplete fixture вызвал публичный `registerTeamWorkflow` с controller без resolver. Genuine thrown error сохранён с повторным выбрасыванием исходного исключения. Отдельная instrumentation-обёртка передавала вызовы настоящему OMP API и измерила:

```text
setLabel=0, on=0, registerTool=0, registerCommand=0
```

Эти counters подтверждают отсутствие частичной регистрации. Одно лишь отсутствие `.work-state` такого доказательства не даёт. Полный exception называет `resolveTrustedToolCallActor` и рекомендует обновить совместимый bundle без ослабления authority. На 100-колоночном TUI startup line весь текст не виден; отчёт не утверждает обратного.

### A6: восемь настоящих отказов `write`

Проверены `actor_unresolved`, `actor_resolver_failed`, невалидный result, смешанный `denied + actor:worker`, `cwd_resolution_failed`, `session_identity_mismatch`, `host_profile_mismatch`, `worktree_mismatch`. Невалидный result и смешанный result оба дали `actor_resolver_invalid_result`.

Каждый fixture-режим задан оператором до запуска, не model input. Sentinel-файлы отсутствуют; уникальный текст исключения не попал в admission response/model log. Проверки structured denial доказывают доставку диагностик, **не** распознавание настоящего чужого caller официальным adapter; последнее остаётся A7 BLOCKED.

### A8: recovery не превратился в idle fallback

PTY input содержит настоящий `/do-work --new`; отдельно сохранены зарегистрированные prepare/instructions tool results. Перед fault injection run был active/discovery, `execution_claim=null`, workers отсутствовали. После намеренной порчи JSON реальные `bash git status --short --branch` и `write` в возвращённый `artifactsDir` получили `workflow_state_recovery_required`.

- Повреждённый state остался неизменным: SHA256 `76dc9fafdff4de4510d690f38726209081353584c1b46278cd6384dd49f8922e`.
- Run-control сохранил исходный SHA256 `8621cabff47969335345ec0955f027d6cfc5c888af44241555296b12d1a7f7a7`.
- Запрошенный artifact отсутствует; другой run/worker не создан.

Первый A8 attempt, в котором модель отказалась вызвать tools сама, не засчитан за PASS. Засчитан A8b с наблюдаемыми tool execution/results.

## Исправленные проблемы setup

Первоначальный bootstrap скопировал internal scope map с отсутствующим в fullstack `omp-engine-specialist`; prepare также получил неподходящие paths и оставил scope пустым. Это исправлено в операторском checklist: public `frontend-developer`, TS glob и конкретный repo-relative файл.

Другой промежуточный attempt не имел исходного Git HEAD и дошёл до summary с pending dependency-baseline DoD. Поздний commit исходного manifest не обновил QA-owned DoD сам по себе. Этот attempt не засчитан за terminal PASS. Финальный A2 использовал корректный baseline **до** первого input и выявил уже отдельный artifact-contract failure.

## Evidence и cleanup

Локальный корень: `.work-state/pr72-host-admission-manual-qa/`.

| Часть | Локальный отчёт |
|---|---|
| Idle tools | `A1.md` |
| Первоначальный scope blocker | `A2.md` |
| Финальный ordinary workflow | `workflow/final-failure-report.json` |
| Финальная инвентаризация cleanup | `workflow/cleanup-inventory.md` |
| CTO positive/negative | `cto/A4.md`, `cto/A4-main.json`, `cto/A4-unauth.json` |
| Первые шесть negative fixtures | `A6.md` |
| Loader counters и дополнительные denials | `negative-completion/completion-report.md`, `negative-completion/a5-oracle/` |
| Foreign-context limit и recovery | `recovery/recovery-qa-report.md` |
| Internal activation | `A9.md` |

Raw PTY/model logs, exact completion arguments и snapshots остаются локальными: в них могут быть session tokens/opaque capabilities. Они не добавлены в Git и не вставлены в этот отчёт. Файловые oracle и genuine exceptions сохранены до удаления временных wrappers/fixtures. Глобальные plugins/config/credentials и старые пользовательские CTO state не менялись.

**Дополнительный дефект harness — `br-vdk`:** `ux-e2e stop` сообщил, что PTY уже завершён, но оставил собственный detached Node wrapper. Main проверил точные executable/script/scratch и PID=PGID, затем закрыл только эту группу существующей shutdown-функцией harness. Остальные сессии завершались через `ux-e2e stop` или `/exit`; собственных live QA-процессов после cleanup не осталось. Это не было массовой остановкой по имени процесса.

**Ограничение evidence:** при cleanup финального A2 агент удалил исходный harness `session.json`; резервная копия не найдена. Main не восстанавливал его предположительными данными. Сохранились исходные model/tool JSONL, transcript и exact completion exchange. Для будущих прогонов raw metadata следует сохранять локально, а не удалять ради исключения из публичного отчёта.

## Что нужно для зелёной приёмки

1. Устранить причины `br-3so` и `br-asz`, затем заново выполнить положительные A2/A3/A4 с настоящими workers и terminal.
2. Отдельно закрыть coverage gap A7, если появится поддерживаемый genuine foreign-context surface; fixture injection не считать его заменой.
3. Проверить исходную внешнюю комбинацию Android bundle + OMP из issue #71 в соответствующей среде.
4. Исправить shutdown harness по `br-vdk`, чтобы штатная остановка не оставляла detached wrapper.
