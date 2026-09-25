# Fresh-session resume and guards

Работай только в scratch project. Не редактируй canonical `.work-state` руками,
не подменяй live registered tools unit-тестом и не используй credentials в
файлах сценария.
Для live-проверки запускай harness без `--scenario` и без `--task`: этот файл
является checklist оператора, а не prompt модели. Вводи slash-команды вручную в
terminal PTY, не передавай старый checklist или chat модели одним prompt.


## Session 1

1. Выполни `/do-work --new "Решение для отчётов"` на
   `feat/run-lifecycle-resume`.
2. Доведи workflow до этапа, где решение и обязательные входы сохранены в
   canonical artifacts/evidence, затем останови `ux-e2e` через `ux-e2e stop
   <scratch>`. Перед restart сохрани report командой `ux-e2e report <scratch>
   --copy-evidence`; harness также автоматически архивирует прежний transcript.
3. Не передавай в новую сессию старый chat или UUID. Raw evidence остаётся в
   `<scratch>/.work-state/ux-e2e/` и в `vibe-report/`.

## Session 2 (same scratch, no previous chat)

4. Запусти тот же scratch заново без `--scenario` и без `--task`/старого chat.
   После появления чистой terminal-сессии вручную введи
   `/do-work продолжи фичу` — без названия прежней задачи и без UUID. После
   того как новая сессия покажет кандидатов, выбери title/list item через
   зарегистрированный selector и только затем ожидай receipt `operation: resume`,
   восстановленные stage/cursor/decision и чтение обязательных artifacts до
   следующего dispatch. Завершённые этапы не должны выполняться повторно.
5. Создай второй незавершённый запуск с тем же понятным названием на отдельном
   scratch/worktree или после безопасного detach. `/do-work --list` должен
   показать различимые branch/status/stage; до выбора не должно быть мутации.
   Выбери номер из конкретного показанного списка, не UUID. Повторный `--list`
   после добавления run не должен переназначать старый пункт.
6. Для проверки recovery используй только безопасный fixture/сценарий,
   подготовленный самим workflow. Если обязательный input отсутствует или
   невалиден, ожидай `recovery_required` с именем evidence и отказ зависимой
   работы. Не создавай поддельный summary и не чинь state вручную.
7. При наличии persisted pending dispatch попроси resume повторно. Receipt
   должен сохранить тот же dispatch identity и сообщить `pending`,
   `background_wait` или `transport_reconnect`; новый worker не создаётся.
8. После terminal A начни обычную новую задачу. Она должна получить
   `operation: new`; наличие истории A не должно навязать старые DoD,
   classification или monotonic gates.

Каждый этап должен быть подтверждён видимым receipt в transcript. Любой typed
отказ (например, `run_selection_required`, `run_busy`, `recovery_required`,
`run_terminal`) фиксируй как отказ без перехода, а не как PASS.
