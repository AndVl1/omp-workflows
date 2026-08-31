# workflow-prepare-future-destination — 2026-09-01

Ветка: `fix/workflow-prepare-future-destination` (без коммитов, по контракту).
Артефакты: `.work-state/features/fix-workflow-prepare-future-destination/artifacts/{implementation.json,dod.json}`.

## Root cause (v0.28.0)

1. **Slot-only resolution.** `resolveState` (packages/core/src/engine/state.ts) резолвил состояние только через слоты — `.active-feature` pointer либо legacy `team-state.json` — и никогда не проверял веточной стейт `features/<deriveFeatureSlugFromBranch(branch)>/state.json`. Когда слот указывал на чужую/старую ветку, собственное состояние текущей ветки становилось невидимым: `prepareWorkflowState` (run.ts) пускал FRESH-prepare («слот stale → можно создавать»), а continuation падал «no non-stale state» — клин в обе стороны.
2. **Bare destination existence.** В `updateStateAtomically` retarget (stale слот + смена ветки) в pre-CAS проверке ключился только на `destination.kind === "present"` — без сравнения владельца (branch destination'а vs ветка мутации) и без разделения «предсуществовало» / «появилось в транзакции» — и всегда отвечал «workflow state was created at the future destination during the transaction». Собственный предсуществующий стейт ветки классифицировался как чужая mid-transaction коллизия.

## Изменённые файлы (3)

- **packages/core/src/engine/state.ts** (+90/−4):
  - `resolveBranchOwnedFeatureState` — probe производного слага ветки; принимается только существующий, парсящийся, containment-безопасный файл с `state.branch === currentBranch`; иначе stale слот остаётся и работают fail-closed проверки. Встроен в оба stale-выхода `resolveState` (pointer и legacy root).
  - `featureDestinationPath` + снапшот `destinationAtResolution` в `updateStateAtomically`: pre-CAS проверка теперь честно классифицирует — предсуществовавший на момент резолюции, неизменённый (revision+raw_hash) и принадлежащий ветке мутации destination → `state_conflict` «workflow state already exists for this branch; use continuation mode»; появившийся/изменившийся в транзакции или чужой → прежний fail-closed «created at the future destination during the transaction». Commit никогда не адаптирует/не перезаписывает destination.
- **packages/core/test/do-work-autonomy.test.ts** (+130/−4): 3 prepare-уровня теста (fresh honest gate; continuation in-place с revision 5→6 и сохранением history; foreign destination fail-closed и byte-untouched) + fixture-хелпер инцидент-формы; `prepareWorkflowState` импортируется из `../src/engine/run.js` (пакетный импорт указывал на устаревший dist v0.28.0).
- **packages/core/test/durable-final-corrections.test.ts** (+113/−1): 3 transaction-уровня теста (honest already-exists классификация через stale `opts.target`; foreign-ownership guard; changed-after-resolution guard). Существующие concurrent-creation тесты не тронуты и зелёные.

`run.ts` не менялся: с ownership-aware резолюцией существующие гейты prepare дают штатные исходы.

## Verification

```
cd packages/core && node --test --import tsx test/durable-final-corrections.test.ts test/do-work-autonomy.test.ts
→ ℹ tests 76, ℹ pass 76, ℹ fail 0, ℹ cancelled 0
```

Только два изменённых тестовых файла; без lint/format/build/project-wide suite. В ходе валидации найдены и исправлены 2 дефекта тестов (не source): пакетный импорт на stale dist и отсутствующий `mkdirSync` каталога destination. Build не запускался (`build_status: "n/a"`), тесты исполняли source напрямую через tsx.

## Независимый ревью

**APPROVED** (по данным оркестратора).

## Control-plane limitation

Переход implementation→verify заблокирован: требуемый механизм `workflow_checkpoint_ask` отсутствует, обычный ask-proof его не даёт. Issue сообщён (reported); proof не фабриковался.
