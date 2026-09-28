# Registered run-lifecycle journey

Эта задача запускается только в scratch project, созданном `ux-e2e bootstrap`. Не
переключай текущий worktree monorepo и не редактируй `.work-state` вручную.
Для live-проверки запускай harness без `--scenario` и без `--task`: этот файл
является checklist оператора, а не prompt модели. Каждую `/do-work` команду
вводи вручную в terminal PTY, чтобы проверить зарегистрированный command surface,
receipt и canonical state; не проси модель «выполнить весь checklist» одним
сообщением.

Оператор выполняет следующие действия через зарегистрированный `/do-work` и
сохраняет каждый видимый `workflow_prepare` receipt в transcript:

1. На `feat/run-lifecycle-a` выполни `/do-work --new "Экспорт отчётов A"` и
   доведи A до quiescent/terminal состояния. Зафиксируй `operation: new`,
   выбранный run и точку продолжения.
2. На той же ветке выполни `/do-work --new "Экспорт отчётов B"`. Receipt обязан
   показать, что A отсоединён с сохранённым прогрессом, а B создан и выбран;
   одинаковая ветка и похожий текст не выбирают A автоматически.
3. В scratch project создай и переключись на `feat/run-lifecycle-c` (например,
   host-командой `git -C <scratch> switch -c feat/run-lifecycle-c`), затем через
   `/do-work --new "Экспорт отчётов C"` создай независимый C. Receipt обязан
   показать ветку C и не переносить состояние A/B.
4. Вернись на `feat/run-lifecycle-a`. Выполни `/do-work --list`, проверь
   понятные названия, ветки, статусы и этапы. Если есть несколько подходящих
   запусков, выбери пункт из только что показанного списка; не вводи UUID и не
   полагайся на порядок после обновления каталога.
5. Попроси `/do-work` доработать **Экспорт отчётов A** естественным языком
   (либо используй `/do-work --rework` с feedback, но без `--run`). Должен быть
   виден `operation: rework`, сохранённая immutable revision/evidence и новая
   точка продолжения. Старый downstream receipt не должен закрыть новую итерацию.

На каждом отказе фиксируй typed code и отсутствие перехода. В частности,
`run_busy`, `run_context_mismatch`, `run_selection_required` и `run_not_found`
не являются успешным переходом. Все tool receipts должны быть видимы в
terminal transcript; не заменяй live tools прямым вызовом `run()` или ручным
созданием canonical state.
