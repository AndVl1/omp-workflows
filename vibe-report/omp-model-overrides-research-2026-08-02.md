# Per-Project Agent Model Overrides — Research Report

- Date: 2026-08-02
- Branch: `feat/per-project-agent-overrides`
- Workflow: `/team full-feature` (autonomous OFF, paused at each checkpoint)
- Status: **research complete, implementation deferred**
- Scope: per-project override моделей для агентов оркестратора OMP

---

## TL;DR

Фича реализуется как **отдельная CLI-команда `/omp-model-overrides`** (по образцу существующего `init-team`), а не как новая стадия в `full-feature` workflow. Команда читает OMP ModelRegistry + `.omp/team.config.json`, интерактивно (через `AskUserQuestion`) выбирает per-role модель для 5 overridable ролей (`architect`, `analyst`, `code-reviewer`, `developer`, `qa`), пишет `.omp/models.json` и генерирует `.omp/agents/<role>-<model>/<role>-<model>.md` с хеш-инвалидацией. Существующий `/team` workflow не меняется — он подхватит per-project агентов через OMP agent discovery.

Архитектура: **pragmatic** (2 core-файла + тонкий wrapper, ~250 LOC, 2 теста, SHA-256 cache invalidation).

---

## Workflow стадии

| # | Stage | Type | Result |
|---|---|---|---|
| 1 | discovery | orchestrator | ✅ `discovery.json` — problem/goal/scope |
| 2 | exploration | consilium (3 parallel) | ✅ `exploration.json` (code map, 6 areas, 10 extension points, 7 do_not_touch, 7 risks) + `exploration_tech.json` (5 patterns, 3 protocols, 3 model refs) + `dod.json` (8 items) |
| 3 | clarify | orchestrator + user checkpoint | ✅ `clarifications.json` — 6 вопросов, 6 ответов |
| 4 | architecture | consilium (3 parallel) | ✅ `architecture.json` + 3 детальных варианта (minimal/clean/pragmatic); выбран pragmatic |
| 5 | implementation | single | ⏭️ SKIPPED — research-only scope |
| 6 | code_review | consilium | ⏭️ SKIPPED — no code |
| 7 | review_fixes | single | ⏭️ SKIPPED — no code |
| 8 | manual_qa | single | ⏭️ SKIPPED — no code |
| 9 | qa_tests | single | ⏭️ SKIPPED — no code |
| 10 | summary | orchestrator | ✅ `summary.json` |

---

## Ключевые находки research (exploration)

### Code map

- **RoleConfig** живёт в `packages/core/src/engine/types.ts:96-105`; `resolveConfig()` в `packages/core/src/engine/config.ts:16-38`; `resolveAgentForRole()` в `config.ts:40-42`.
- **Резолв role→agent** идёт через `StageContext.agent(role)` (closure), используется в `runSingle` (stage.ts:219-241) и `runConsilium` (stage.ts:244-283).
- **Task tool модель** берётся из agent frontmatter `model:` (например `model: "@task"` в `packages/fullstack/agents/analyst.md`); `AgentDefinition.model?: string[]` в `node_modules/@oh-my-pi/pi-coding-agent/src/task/types.ts:367`. `FinalizeRunArgs.modelOverride` (executor.ts:2046) уже существует, но **не прокидывается из stage.ts**.
- **Agent discovery** сканирует `<cwd>/.omp/agents/*.md` через `discoverAgentsForCreate()` (task/discovery.ts) — сгенерированные per-project агенты будут подхвачены автоматически без изменений в OMP core.
- **Pause/checkpoint** механизм — `setPause()` в `state.ts:150-152`, `PauseKind.user_checkpoint`, вызывается оркестратором (не engine автоматически).

### Extension points

1. `packages/core/src/engine/types.ts:96-105` — добавить `model_overrides?: Record<string, string>` в `RoleConfig`.
2. `packages/core/src/engine/config.ts:16-38` — merge `model_overrides` после `roles`.
3. `packages/core/src/engine/stage.ts:47-52` — принять `model?: string` в `TaskCaller.call`.
4. `packages/core/src/engine/stage.ts:219-241` — прокинуть `model` через `ctx.task.call({ agent, task, model })`.
5. `packages/core/src/engine/stage.ts:244-283` — прокинуть `model` per-task в `ctx.task.batch(...)`.
6. `packages/core/workflows/full-feature.json` — НЕ добавлять новую стадию (rejected: отдельная команда).
7. `node_modules/@oh-my-pi/pi-coding-agent/src/task/discovery.ts` — `discoverAgentsForCreate` уже сканирует `.omp/agents/`; генерация работает без изменений.

### Do not touch

- `RoleConfig.roles` (types.ts:107-124) — backward compat.
- `DoDItem` interface (types.ts:115-123) — старые `dod.json` ломаются при ренейме.
- `TeamState.pause` shape (state.ts:150-152) — consumed by external tools.
- `TaskCaller` interface (stage.ts:40-54) — additive only.
- `StageDef.type` enum (`orchestrator|single|consilium|bash|none`) — exhaustive switch в `runStage()`.

### Risks

- `TaskCaller.call` `modelOverride` уже есть в executor, но **stage.ts не прокидывает** — easy to miss the executor side при threading.
- agent frontmatter `model:` (`@slow`/`@smol`/`@task`) resolved by model registry; unknown provider/model silently falls back (executor.ts:2639-2643).
- generated `.omp/agents/<role>-<model>/*.md` re-discovered on every `discoverAgentsForCreate()` call — кеша нет, нужно ручное удаление для пересоздания.
- Вставка новой стадии в `full-feature.json` shifts indices, ломает hardcoded `skip_if`/`loop.back_to` references — **именно поэтому выбрана отдельная команда, а не новая стадия**.
- `applyRosterOverrides` (stage.ts:468) re-resolves config per stage — выбор модели не persisted между stages (acceptable, конфиг всё равно re-read).
- Autonomous mode (`[AUTONOMOUS]`) в CLI-команде решен через `--force`/default-prompt UX, не через engine checkpoint.

---

## Принятые решения (clarify)

| # | Вопрос | Решение |
|---|---|---|
| 1 | Источник моделей | **hybrid** — `.omp/models.json` если есть, иначе OMP ModelRegistry |
| 2 | Naming convention | **kebab** — `<role>-<model-slug>` (e.g. `architect-deepseek-flash.md`) |
| 3 | Interaction protocol | **cli_command_init_team** — НЕ новая стадия, отдельная команда `/omp-model-overrides` (решение пользователя) |
| 4 | Override scope | **fixed_subset** — только `architect`, `analyst`, `code-reviewer`, `developer`, `qa` |
| 5 | Storage | **separate_file** — `.omp/models.json`, не поле в `team.config.json` |
| 6 | Regen | **auto_on_change** — SHA-256 hash check, пересоздать при mismatch |

Доп. решение (из ответа про agent_source_dir): приоритет source agent = `.omp/agents/<role>.md` (project-level, accommodates init-team overrides) → fallback на `packages/fullstack/agents/<role>.md` (bundled).

---

## Архитектура (выбрана pragmatic)

3 варианта сравнивались; выбран pragmatic.

| Variant | LOC | Files | Caching | Validation | Tests | Trade-off |
|---|---|---|---|---|---|---|
| minimal | ~150 | 1 | no | no | 0 | быстро, fragile |
| **pragmatic** | **~250** | **3** | **SHA-256** | **WARN-on-unknown** | **2** | **ship-ready** |
| clean | ~400 | 5+ | SHA-256 | throw-on-unknown | 5+ | фундамент, но дольше |

### Pragmatic-файлы

**Новые:**
- `packages/core/src/model-overrides/schema.ts` — `ModelsJson`, `ModelEntry`, `OverrideEntry`, `validateModelsJson()`, `CORE_OVERRIDABLE_ROLES`.
- `packages/core/src/model-overrides/command.ts` — `runModelOverrides(args, ctx)`.
- `packages/core/src/model-overrides/index.ts` — re-exports.
- `.omp/commands/omp-model-overrides/index.ts` — thin wrapper, `CustomCommand` factory.
- `packages/core/test/model-overrides.test.ts` — happy path + invalid schema.

**Modified:**
- `packages/core/src/index.ts` — add `model-overrides` exports.
- `README.md` — document new command.

**Untouched:**
- `packages/core/src/engine/**`
- `packages/core/workflows/full-feature.json`
- `packages/fullstack/agents/*.md`

### Data flow

```
read team.config.json
  → enumerate available models (OMP ModelRegistry)
  → AskUserQuestion (CORE_OVERRIDABLE_ROLES × models grid)
  → validate inputs (validateModelsJson)
  → write .omp/models.json
  → for each override:
       read source agent .md (.omp/agents/<role>.md → bundled)
       replace frontmatter name/model
       write .omp/agents/<role>-<model>/<role>-<model>.md
       compute SHA-256(.omp/models.json + source .md)
       write .omp/agents/<role>-<model>/.source-hash
  → return summary string
```

### Type signatures (pragmatic core)

```ts
export const CORE_OVERRIDABLE_ROLES = [
  "architect", "analyst", "code-reviewer", "developer", "qa"
] as const;

export type CoreOverridableRole = typeof CORE_OVERRIDABLE_ROLES[number];

export interface ModelsJson {
  schema_version: 1;
  models: ModelEntry[];
  overrides: Record<string, OverrideEntry>;
}

export interface ModelEntry {
  id: string;
  label: string;
  provider: string;
  model_id: string;
  thinking?: string;
}

export interface OverrideEntry {
  model_id: string;
  agent_slug: string;
}

export function validateModelsJson(raw: unknown): ModelsJson;
// throws on JSON parse error or missing required field;
// logs WARN and filters unknown roles (typo-tolerant).

export async function runModelOverrides(
  args: string[],
  ctx: HookCommandContext
): Promise<string>;
// returns human-readable summary of work done.
```

### Tests

1. **happy path** — `runModelOverrides` в test dir, assert `.omp/models.json` + `.omp/agents/<role>-<model>/*.md` + `.source-hash` созданы с правильным frontmatter.
2. **invalid schema** — `validateModelsJson(malformed)` throws с описательным сообщением.

---

## DoD черновик (8 items)

| ID | Описание | Evidence |
|---|---|---|
| config_schema | `.omp/models.json` schema: `schema_version`, `models[]`, `overrides{}` | unit test parses valid + rejects malformed |
| stage_dispatch | `/team` workflow **не меняется**; новые агенты подхватываются discovery | существующие тесты /team проходят без изменений |
| model_selection_cmd | `/omp-model-overrides` создаёт `.omp/models.json` + `.omp/agents/<role>-<model>/*.md` после диалога | integration test: command run → files exist + content valid |
| agent_generation | Generated agents в `.omp/agents/<role>-<model>/`, frontmatter `name:` + `model:` переопределены, остальное как в source | unit test reads generated, compares frontmatter to source |
| source_priority | `.omp/agents/<role>.md` имеет приоритет над `packages/fullstack/agents/<role>.md` | unit test: положить .omp/agents/architect.md, проверить что используется он |
| hash_invalidation | SHA-256 от (`.omp/models.json` + source agent .md) → `.source-hash`; при mismatch — regenerate | unit test: изменить source, запустить command, проверить что .md пересоздан |
| backward_compat | Проект без `.omp/models.json` работает как раньше; `/omp-model-overrides` без --force = prompt (не skip) | regression test: existing fixtures, no override config |
| tests | 2 unit теста: happy path + invalid schema | `npm test` passes, coverage не падает |

---

## Open questions для implementation-этапа

1. Как именно прокинуть `model` в task tool из generated `.md`? Достаточно ли положиться на OMP ModelRegistry (subagent сам резолвит), или нужно явно патчить `params.model` в `TaskCaller.call`?
2. `CustomCommandAPI` в этой версии omp — есть ли у неё доступ к `modelRegistry`? (Видится ли `ctx.modelRegistry` в `.omp/commands/init-team/index.ts`?)
3. Куда положить generated `.omp/agents/*` файлы в runtime — в проект, где вызвана команда (`cwd`) или в `process.cwd()`?
4. Должна ли команда обновлять `.omp/team.config.json`, или только создавать `.omp/models.json` параллельно? (Сейчас решено: только `models.json`.)

---

## Артефакты

- `.work-state/team-state.json` — runtime state (в gitignore)
- `.work-state/team-state.md` — human mirror
- `.work-state/artifacts/discovery.json`
- `.work-state/artifacts/feature_spec.json`
- `.work-state/artifacts/exploration.json`
- `.work-state/artifacts/exploration_tech.json`
- `.work-state/artifacts/dod.json`
- `.work-state/artifacts/clarifications.json`
- `.work-state/artifacts/architecture.json`
- `.work-state/artifacts/architecture_minimal.json`
- `.work-state/artifacts/architecture_clean.json`
- `.work-state/artifacts/architecture_pragmatic.json`
- `.work-state/artifacts/summary.json`

---

## Следующий шаг (отдельный `/team` запуск)

Когда пользователь скажет "go" — новый `/team` с задачей:

> Реализовать `/omp-model-overrides` per approved architecture (pragmatic variant). Inputs: все `.work-state/artifacts/*.json`. Не правь `/team` workflow, не правь `full-feature.json`. Добавь `packages/core/src/model-overrides/{schema,command}.ts`, `.omp/commands/omp-model-overrides/index.ts`, 2 теста в `packages/core/test/model-overrides.test.ts`. Не забудь `validation_evidence`: `npm run build` + `npm test` в packages/core.

Перед стартом проверить:
- `CustomCommandAPI` есть `modelRegistry` в `ctx` (иначе нужно уточнять API для enumerate моделей).
- `node_modules/@oh-my-pi/pi-coding-agent` version совместима с `discoverAgentsForCreate` для `.omp/agents/*.md`.
- Текущая `packages/core/src/index.ts` структура экспортов — куда добавить model-overrides exports.
