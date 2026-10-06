# Proposal

## Why

Ручной запуск на OMP 18.4.9 выявил `execution_claim_mismatch`: cache-tagged копии private/core-модулей расходились в controller и приватной привязке claim одной SDK-сессии. Исправление уже реализовано в `f37c006e77fbc0fa02de1e4f8fee9a3e9b378386`; требуется закрепить наблюдаемую границу authority и регрессионную приёмку, не переписывая исторические результаты `run-lifecycle` и `reliable-stage-execution`.

## What Changes

- Добавляется контракт переиспользования одного host scope при повторном SDK import/activation одного private owner: без независимых controllers и повторных эффектов engine hooks.
- Закрепляется изоляция по доверенной runtime identity: совпадающие строковые UUID/cwd и копия manager не дают полномочий; явный worker не становится host через повторную регистрацию.
- Описываются согласованность primary UI/headless-представлений и сужение interactive rights при headless-событии независимо от порядка загрузки aliases.
- Фиксируется сохранность exact-controller CTO claim binding между копиями core без переноса credentials на другой controller.
- Закрепляются single private workflow owner в этом монорепозитории и приёмка через действующий SDK, accepted publications, matching terminals и штатное завершение.
- В `design.md` и `tasks.md` фиксируются уже выполненный cutover и проверенные результаты. Это ретроспективное описание shipped repair, а не разрешение повторно реализовать его или запускать новые H-прогоны.

## Capabilities

### New Capabilities

- `sdk-session-authority`: согласованность и изоляция host/session authority при SDK module aliases, UI/headless-переходах и повторной активации private бандла.

### Modified Capabilities

Нет. Общие контракты run ownership, producer assignment, публикации и recovery не заменяются; новый delta содержит только `ADDED Requirements`. Текущий CLI inventory main specs пуст, поэтому требование не объявляется `MODIFIED` без существующей базовой версии.

## Impact

- Реализация, уже вошедшая в `f37c006`: `packages/omp-workflows-internal/src/index.ts`, `packages/core/src/engine/host-controller.ts`; профильные проверки — `packages/omp-workflows-internal/test/entry.test.ts`, `packages/core/test/cto-ownership.test.ts`.
- Private загрузка: `.omp/settings.json` и `.omp/plugin-overrides.json`; пояснения — корневой README и `packages/core/README.md`. Public fullstack отключён только для этого проекта, не глобально.
- Публичные сигнатуры, workflow-профили, формат canonical state/receipt и версии пакетов не изменяются. Original failed run `1dc1fa60-e813-472c-a16e-f887f7898de0` не мигрировался и не изменялся.
- Новая работа ограничена артефактами этого change; интеграционный владелец и единственный writer — основной агент. Production code, существующие changes, пользовательские main specs/archive и историческая приёмка остаются без изменений.
- Вне scope: `br-xol` (fail-fast при неполном native parent context), `br-skh` (validation-recovery context неверной native publication), unused cleanup, новые SDK adapters, release/version bump, sync и archive.
