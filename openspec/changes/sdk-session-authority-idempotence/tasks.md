# Tasks

Ретроспективная фиксация уже выполненного `f37c006e77fbc0fa02de1e4f8fee9a3e9b378386`. Отметки implementation/runtime ниже основаны на наблюдённых результатах, перечисленных в `design.md`, и не разрешают повторные H-прогоны или новую реализацию. Существующие `run-lifecycle` 32/32 и `reliable-stage-execution` 30/30 не меняются. Archive/sync и открытые `br-xol`/`br-skh` не являются задачами этого change.

## 1. Реализованная граница session authority

- [x] 1.1 Заменить module-local private bindings/activation на стабильный versioned scope для exact event bus и manager без старого параллельного пути; подтверждение: shipped private entry, source review APPROVE и разрешённая selected-run mutation через tagged aliases в `entry.test.ts` (SA01, SA02).
- [x] 1.2 Согласовать primary UI/headless scope, отказ copied manager и изоляцию workers без повышения UI прав; подтверждение: interactive-first/headless-first и headless command denial в tagged-alias regression, ownership/entry/namespace suite 42 PASS (SA02, SA03).
- [x] 1.3 Разделить CTO credentials между core graphs только по exact controller receiver и сохранить canonical checks/release; подтверждение: `cto-owner: tagged core ingress binds and releases only the exact shared controller` в `cto-ownership.test.ts`, отдельный receiver без inherited claim и штатный suspend/release (SA04).

## 2. Выполненный cutover и поведенческая проверка

- [x] 2.1 Выбрать canonical private package directory и project-only override public fullstack; подтверждение: fresh actual repository command discovery `/omp-do-work`, `/omp-team`, `/omp-cto` и native discovery трёх private workers, глобальное disable не выполнялось (SA05).
- [x] 2.2 Проверить смежные producer/terminal границы и типы; подтверждение: ещё 54 native authority / ordinary SDK terminal / execution producer tests PASS, всего focused 96 PASS, core/fullstack/internal typecheck PASS и exact-head remote CI37222564139 SUCCESS (SA01–SA04, SA06).
- [x] 2.3 Выполнить bounded proof на фактическом `omp/18.4.9` с сохраняемой parent session; подтверждение: run `abebf610-b8e7-4b5c-a681-b5f12aa4542d`, три accepted logical exploration publications и три `succeeded/provider_terminal`; ошибки fixture и ограничения ordinary/live CTO/H scopes разделены в evidence (SA06).
- [x] 2.4 Продолжить тот же proof run без повторного task и завершить fan-in/summary; подтверждение: один native task за весь run, discovery/exploration/summary done, capability complete, pause done, пять immutable payload SHA256 verified и natural execution claim null; original user run не изменялся (SA06).

## 3. Фиксация OpenSpec контракта

- [x] 3.1 Создать proposal, ADDED delta `sdk-session-authority`, design с решениями/альтернативами и эту evidence-backed task list; подтверждение: четыре артефакта присутствуют в новом change, нормативный spec не фиксирует Symbol/WeakMap mechanism и не изменяет исторические changes.
- [x] 3.2 Проверить новый change строгим OpenSpec validator, фактическим CLI status/apply progress и независимым read-only review на соответствие shipped source и evidence; подтверждение: strict validation PASS без issues, CLI корректно прочитал девять задач, review APPROVE после уточнения trusted headless capture в SA03, незакрытых замечаний нет; без нового production/runtime запуска.
