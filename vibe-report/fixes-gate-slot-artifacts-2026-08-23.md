# Stale slot-artifact binding fix and release report

Дата: 2026-08-23

## Причина

В transcript `sys-prompt-actualize` зафиксирован отказ `workflow_complete`:

`slot artifact conflict: slot 'tech-researcher' wrote 'exploration-tech-researcher' with different content`.

Continuation переоткрывал `exploration`, но старые `slot_artifacts` оставались в том же canonical state:

`.work-state/features/sys-prompt-actualize/state.json`

При повторном completion engine сравнивал исправленный артефакт с hash предыдущей невалидной попытки и останавливал workflow.

## Исправление

- PR #44: https://github.com/AndVl1/omp-workflows/pull/44
- Fix commit: `897e031` — `fix(core): reset stale workflow bindings safely`
- Merge commit: `e4bdf67`

Исправление выдаёт новый capability для reopened/pending stage, очищает slot bindings affected и downstream stages и удаляет только stale snapshots внутри canonical artifact tree. Upstream artifacts и внешние пути сохраняются.

Второй defect, исправленный в том же PR: read-only JSON validation под `.work-state/**/artifacts` больше не классифицируется как запись canonical workflow state.

## Проверка

- Focused regression tests: `47 pass, 0 fail`.
- TypeScript compilation для `packages/core`: exit code `0`.
- Bundle smoke build прошёл.
- PR check `build, typecheck, test`: success, run `32631444325`.
- PR #44 merged в `main`.

## Релиз `v0.23.1`

- Release commit: `2a6ec4a` — `chore(release): v0.23.1`.
- Tag `v0.23.1` создан на release commit и опубликован.
- Release CI: run `32642205134`, success; build/typecheck/test, version guard, публикация обоих пакетов и GitHub Release завершились успешно.
- Published packages:
  - `@andvl1/omp-workflows-core@0.23.1`
  - `@andvl1/omp-workflows-fullstack@0.23.1`
- GitHub Release: https://github.com/AndVl1/omp-workflows/releases/tag/v0.23.1

## Следующий шаг

Для исходного incident отдельный fix не требуется. При повторном workflow continuation нужно использовать engine-owned `workflow_prepare`/`workflow_begin`; canonical `.work-state` вручную не редактировать.
