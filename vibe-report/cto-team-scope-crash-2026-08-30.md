# Исправление падения `/cto` на `scope`

## Причина

`.omp/teams.json` содержал строку в `scope`, хотя контракт `TeamDef` требует `string[]`. `loadTeamDefs` проверял только `id` и `name`, поэтому пропускал некорректную запись в `renderTeamsTable`, где вызов `t.scope.join(...)` завершался `TypeError`.

## Изменения

- Исправлен project-local team registry: `scope` теперь содержит идентификатор из `.omp/team.config.json` — `["dev"]`.
- `loadTeamDefs` теперь полностью проверяет обязательную форму `TeamDef` на границе чтения JSON и fail-closed исключает некорректные записи.
- Добавлен регрессионный тест со строковым `scope`; команда должна отработать без исключения и не публиковать некорректную команду.

## Проверка

- `npm run build:core` — успешно.
- `node --test --import tsx packages/core/test/cto-command.test.ts` — 12/12 тестов успешно.
- `npm run build -w @andvl1/omp-workflows-internal` — успешно.
- `npm run build:fullstack` — успешно.
- OMP v18.0.11 запущен с bundle из текущего worktree; `/cto scope smoke` принят command surface и перешел в CTO workflow без `Extension "command:cto" error`. Smoke prompt после подтверждения результата остановлен.
