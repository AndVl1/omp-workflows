# Design

## Context

Мотивация — в `proposal.md`; наблюдаемое поведение — в `specs/sdk-session-authority/spec.md`. Это ретроспективный follow-up к уже shipped `f37c006e77fbc0fa02de1e4f8fee9a3e9b378386`, а не повторная реализация.

SDK может импортировать private/core через несколько cache-tagged ESM graphs и предоставить несколько API facades одного host runtime. Модульные private session maps и флаги activation расходились: один controller приобретал canonical claim, другой видел ту же сессию без private credentials и отвечал `execution_claim_mismatch`. Аналогичный межмодульный разрыв возможен, когда CTO ingress привязывает credentials к controller из другой копии core.

Общие определения run/session identity и ownership остаются в `run-lifecycle`; producer assignment, accepted receipt, matching terminal и recovery — в `reliable-stage-execution`. Их исторические 32/32 и 30/30 не меняются. В этой работе единственный writer новых артефактов и владелец интеграции — основной агент; исследование archive-зависимостей и review выполняются read-only.

## Goals / Non-Goals

**Goals:**
- Разделить identity host runtime, manager, API facade и module graph; не приравнивать import alias к новой сессии.
- Согласовать private claim holder и регистрацию engine, сохранив сужение UI authority и изоляцию workers.
- Описать mechanism и evidence достаточно точно для дальнейшего рефакторинга без привязки нормативного контракта к именам внутренних контейнеров.

**Non-Goals:**
- Новые публичные API, зависимости, пакеты, формат canonical state или совместимость разных registry schema versions без restart.
- Ремонт SDK, автоматическое создание parent session вопреки `--no-session`, новый recovery path для невалидного output.
- Повторные H-прогоны, расширение исторической матрицы, перенос результатов SDK18.0.6 на SDK18.4.9.
- Архивирование, main-spec sync, изменение существующих changes, пользовательских версий и original failed run.

## Decisions

### 1. Registry живёт на границе процесса, authority — на границе exact SDK identity

Private entry использует versioned process-global slot `Symbol.for("omp-workflows.internal-host-registry")`. Slot содержит weak associations API facade → стабильный scope и event bus → exact manager → scope, отдельные associations для явно non-host actors и activation set стабильных scopes. Shape/version slot проверяются; несовместимый slot не заменяется молча.

Ключами служат доверенные объектные references, не UUID, cwd, serialized context или путь импортированного файла. Alias одного primary host соединяется с существующим scope только после проверки runtime/manager/actor association; конфликт возвращает отказ до публикации новой binding в cache. Already-bound или already-activated независимые scopes не объединяются произвольно.

Альтернатива — только канонизировать путь загрузки: полезна для project config, но не устраняет разные SDK cache tags/facades. Альтернатива — registry по session ID/cwd: отвергнута, поскольку подменяет объектную provenance копируемыми полями. Модульный singleton оставляет исходный split-brain.

### 2. Стабильный scope не означает бессрочные права

Primary print/headless и UI aliases одного exact runtime/manager используют один host scope, включая headless-first порядок. Headless capture сужает interactive rights общего binding; новый доверенный UI capture может подтвердить их снова. Явный worker/lead/unknown actor не объединяется с primary host и не повышается сменой actor label.

Проверки текущего snapshot, lifecycle replacement/shutdown и canonical ownership остаются в существующих путях. Stable scope нужен для переиспользования registration, а не переноса claim в successor session. Копия manager не должна отравлять действующий binding исходного host.

Альтернатива — отдельные controllers для UI и primary headless: отвергнута из-за расхождения claim и возможности сохранить UI-only права через stale facade. Альтернатива — считать любой headless child событием primary: отвергнута, поскольку чужой worker не должен отзывать host authority.

### 3. Engine activation привязана к scope, а не к facade

В `packages/omp-workflows-internal/src/index.ts` registration engine сохраняется однократной для стабильного scope, в том числе при переходе от начальной facade-only association к manager-backed association. Это устраняет повторные admission/lifecycle эффекты; SDK descriptors сохраняют существующий eager registration contract.

Все обращения к прежним module-local private session bindings заменены scope helpers; параллельного старого authority cache или compatibility shim нет. Не вводится новый публичный SDK interface.

### 4. CTO credentials разделяются только по точному controller receiver

В `packages/core/src/engine/host-controller.ts` slot `Symbol.for("omp-workflows.cto-claim-bindings")` хранит versioned WeakMap exact controller object → credentials. Это позволяет методу controller из одной копии core увидеть binding, созданный ingress другой копии.

Новый controller, даже с тем же context, не имеет этой привязки. Canonical token/session/PID/ownership-epoch validation и штатное clear/release сохранены. Credentials не сериализуются и не восстанавливаются по строковым IDs. Сигнатуры существующих exports не менялись.

Альтернатива — передавать module-specific registry через каждую caller surface: потребовала бы нового публичного plumbing и не решала бы уже импортированные receivers. Экспортируемый cache по run/session ID ослабил бы границу полномочий.

### 5. Конфигурация выбирает один private package owner

`.omp/settings.json` указывает `packages/omp-workflows-internal`, не `node_modules` alias и не отдельный `dist/index.js`. Каталог пакета сохраняет discovery его агентов и skills. `.omp/plugin-overrides.json` исключает `@andvl1/omp-workflows-fullstack` только в этом проекте; глобальная public установка остаётся включённой для остальных проектов.

Конфигурационный cutover дополняет, но не заменяет registry repair: split-brain воспроизводился и в fixture с одним private package owner. Альтернатива — глобально отключить public plugin или удалить gates — отвергнута как unrelated изменение и обход trust boundary.

### 6. Evidence разделяет контракт, реальный SDK и ошибки fixture

| Проверка | Наблюдённый результат и граница |
|---|---|
| `entry.test.ts`: tagged private aliases | Selected-run разрешение через разные imports/facades, interactive-first/headless-first, отказ copied manager, сохранность исходного host и отказ headless command |
| `cto-ownership.test.ts`: tagged core ingress | Реальный canonical CTO ingress/binding/release для exact receiver из другого module graph; отдельный controller с тем же context не наследует credentials |
| Ownership/entry/namespace suite | 42 PASS; это Node contract tests, не live SDK CTO proof |
| Native authority / ordinary SDK terminal / execution producers | 54 PASS; total focused 96, без заявления нового полного local suite |
| Core/fullstack/internal typecheck | PASS |
| Actual установленный `omp/18.4.9` | Persisted RPC research run `abebf610-b8e7-4b5c-a681-b5f12aa4542d`: один native task, три отдельных workers, три accepted exploration publications и три `succeeded/provider_terminal` |
| Штатное продолжение того же run | Без нового dispatch: engine fan-in → summary; discovery/exploration/summary done, capability complete, pause done, пять immutable payload SHA256 verified, execution claim естественно null |
| Actual repository command surface | `/omp-do-work`, `/omp-team`, `/omp-cto` обнаружены в свежем OMP с canonical private path/project override |
| Exact remote CI `f37c006e77fbc0fa02de1e4f8fee9a3e9b378386` | [Run 37222564139/job111495702392](https://github.com/AndVl1/omp-workflows/actions/runs/37222564139/job/111495702392): SUCCESS, 265s, install/build/typecheck/D/P/full Test |
| Independent source/config review | APPROVE; read-only review не объявляется независимо выполненным runtime |

Live proof установил версию через реально запущенный executable. Соседние SDK package metadata не использовались как доказательство ABI этого executable. Новая live проверка — ordinary research, не live CTO18.4.9 и не новый H tranche.

Первоначальные probe failures сохранены как ошибки проверки: `--no-session` не предоставлял parent session file/lineage; physical `exploration-<slot>` не являлся logical output ID `exploration`; worker-у ошибочно поручили main-only `workflow_instructions`. После исправления последнего запроса coordinator продолжил уже принятые results без повторного task. Это корректировка fixture, а не отключение producer/control gates или доказательство автоматического восстановления любого отказа.

Portable evidence: source/regression tests в shipped commit, закрытый `br-zpx`, [PR77 repair/CI comment](https://github.com/AndVl1/omp-workflows/pull/77#issuecomment-5982911348). Safe `local://selected-claim-sdk1849-proof.json` — дополнительный private provenance, не CI artifact и не обязательная зависимость для archive. Raw SDK transcripts, credentials и auth URLs не публикуются. Пять owned RPC services остановлены, disposable scratch и decoded SDK copies удалены.

## Risks / Trade-offs

- [Process-global slot переживает module imports, но не restart] → версия и shape registry проверяются; upgrade загруженных factories требует полного restart OMP, не замены slot через обход.
- [Object identity требует стабильного SDK manager reference] → неподтверждённая association отказывается; shared scope не восстанавливается по скопированным строкам. Поддержка нового SDK contract потребует отдельного анализа.
- [Stale facade может заявлять `hasUI`] → interactive capability определяется последним доверенным capture общего primary scope, а не одним UI-флагом caller.
- [Registry может случайно стать источником durable authority] → private credentials остаются exact-object bindings; canonical claim, stage assignment и lifecycle остаются отдельными обязательными проверками.
- [Ошибку fixture можно спутать с production regression] → evidence хранит конкретные отказы и коррекции отдельно; `br-xol` и `br-skh` остаются открытыми, не включаются в done этого change.
- [Историческая приёмка может быть расширена задним числом] → новый delta не изменяет прежние tasks/evidence и не переносит их SDK/H результаты.

## Migration Plan

1. Уже выполнено в `f37c006`: module-local authority пути заменены стабильным scope registry и exact-controller CTO binding; callers и regression tests переведены без shims.
2. Уже выполнено: сборка linked packages и project config cutover; свежие SDK процессы проверили native lifecycle и private namespace. Открытый до обновления процесс не считается автоматически обновлённым.
3. Пользователь продолжает сохранённый run после штатного restart через `/omp-do-work --resume --run <run-id>`. Original failed run не редактировался; его фактический resume в этом proof не заявляется.
4. Rollback, если потребуется, — штатная загрузка предыдущего build/config после остановки собственного host; не ручная запись canonical state, перенос token или восстановление старого cache. Известный дефект предыдущего build при rollback остаётся известным, а не безопасным fallback.
5. В будущей отдельно разрешённой archive операции: сначала `run-lifecycle`, затем `reliable-stage-execution`, затем этот follow-up. Для каждого — оценить/синхронизировать delta в main и проверить результат до перемещения change; не использовать archive-only как замену sync. Новая capability имеет только ADDED Requirements и Purpose, поэтому не требует выдуманной MODIFIED baseline.
