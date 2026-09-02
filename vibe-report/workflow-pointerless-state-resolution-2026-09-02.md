# Исправление pointerless state resolution

- **Issue:** `br-2up`
- **Симптом:** `fresh prepare` сообщал, что state уже существует, тогда как continuation сообщал, что non-stale state не найден.
- **Причина:** resolver проверял только derived branch state за pointer/legacy paths. Поэтому pointerless state или отсутствие stale target, на который указывал pointer, скрывали существующий валидный state.
- **Исправление:** выполнен хирургический fallback resolver для явной ветки; malformed/foreign state обрабатываются fail-closed; stale missing pointer ретаргетится; для same-path stale/foreign destination выполняется финальная инспекция.

## Изменённые core-файлы

- `packages/core/src/engine/state.ts`
- `packages/core/test/do-work-autonomy.test.ts`
- `packages/core/test/durable-final-corrections.test.ts`

## Проверка

- `npm run typecheck` — PASS
- Focused tests — 84/84
- Full core tests — 869/869
- Diff-check — PASS
- Независимое ревью — APPROVE

Релиз и merge ещё не заявляются.

Несвязанные `.playwright-cli/` и два существовавших ранее плана в `vibe-report/` не затрагивались:

- `vibe-report/agent-feature-development-plan-2026-08-09.md`
- `vibe-report/plugin-dx-plan-2026-08-09.md`
