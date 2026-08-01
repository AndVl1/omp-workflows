# Validation gate + orchestrator discipline — 2026-08-01

## Что сделано

`@andvl1/omp-workflows-core` v0.8.0. Главное изменение: субагенты больше не
могут отдать `ready: true` без machine-checkable validation evidence.

### Engine layer

`packages/core/src/gates/validation.ts` — новый gate. Ключевая инвариантa:
стадии, которые производят code-bearing артефакты (`implementation`,
`review_fixes`), ОБЯЗАНЫ содержать в artifact JSON:

- `ready: "true"`
- `validation_run: "true"` (строка, не boolean — потому что субагенты в
  markdown-block-выводе эмиттят строковые значения, и мы это поддерживаем)
- `validation_evidence`: непустая строка с verbatim build/test output

Без этого stage помечается `failed`, walkProfile останавливается, и
орк-р вынужден респаунить developer-агента с причиной отказа как новой
задачей.

Gate подключён в `runSingle` и `runConsilium` через `validateProduced()`,
которая фильтрует produces по `{"implementation", "review_fixes"}` — это
важно: гейт срабатывает только для стадий, которые ДЕЙСТВИТЕЛЬНО
производят code. Кастомные профили, переиспользующие id `implementation`
для не-code стадий (например, документирования), не задевают.

### Stage prompt reframe

`buildStagePrompt` теперь добавляет role-specific role-hint:

- Orchestrator roles (`coordinator`, `coordinator-yolo`, `discovery`):
  "You are a DISPATCHER and INTEGRATOR, not a coder. Spawn subagents for
  any code work, read their artifacts, decide whether to proceed. Do NOT
  edit code yourself — if a subagent's output is wrong, re-spawn with a
  sharper task; do not patch their artifact."
- Все остальные: "You are an EXECUTOR, not a router. If your stage
  produces code, you MUST run the project's build + tests + linter
  yourself and include the verbatim output in the artifact's
  `validation_evidence` field, with `validation_run: true`. The engine
  will reject the handoff otherwise. Do not invent escape hatches like
  'orchestrator owns validation' — that contract does not exist."

### Command + agent frontmatter

`packages/fullstack/commands/do-work/index.ts` — две новые секции в
`buildPrompt`:

- **Subagent validation contract** — машино-проверяемый контракт, что
  ожидается, что будет, если нарушить.
- **Orchestrator discipline** — список запретов: не редактировать код,
  не re-run-ить build-результаты, не пропускать стадии, не помечать done
  чтобы разблокировать, на gate-отказе — респаунить с тем же агентом и
  причиной отказа как новой задачей.

`packages/fullstack/agents/{developer-go,developer-kotlin,developer-mobile,frontend-developer}.md`
— каждый получил `## Validation contract (machine-checked, v0.7.0+)` секцию
с явным "no `validation_run: false` escape hatch" вордингом.

## Архитектурное наблюдение

Корневая причина failure mode из сессии `019fbd62` — не в LLM, а в
отсутствии **машино-проверяемого** контракта. Словесный "Run validation
before reporting" в agent frontmatter был, но LLM сгенерировал
`validation_run: false` с пометкой "Per assignment, orchestrator owns
validation" — галлюцинация, никакого assignment не было. Без
машино-проверяемого последствия subagent может объехать любую
документацию.

Engine gate закрывает это навсегда: документы можно редактировать, LLM
может галлюцинировать, но JSON-артефакт проверяется по полям, и
`validation_run: "false"` физически не проходит. Текстовая
документация остаётся как defense in depth, но engine — это source of
truth.

## Тесты

- 16 новых тестов в `packages/core/test/validation-gate.test.ts`:
  - 8 unit (PASS, missing-ready, validation_run:false, empty evidence,
    missing evidence, boolean true, non-required stage, review_fixes)
  - 3 file-based (missing file, valid file, malformed JSON)
  - 1 resolveArtifactsDir
  - 4 runStage integration (implementation unvalidated → failed,
    validated → done, discovery unaffected, missing artifact → failed)

Всего 49 core + 11 fullstack = 60, все зелёные.

## Файлы

### Новые
- `packages/core/src/gates/validation.ts` — gate
- `packages/core/test/validation-gate.test.ts` — 16 тестов

### Изменены
- `packages/core/src/engine/stage.ts` — `runSingle`/`runConsilium` пропускают
  артефакты через gate; `buildStagePrompt` инжектит role-hint
- `packages/core/src/index.ts` — version bump 0.7.0 → 0.8.0
- `packages/core/package.json` — version bump
- `packages/fullstack/commands/do-work/index.ts` — две новые секции в prompt
- `packages/fullstack/agents/developer-go.md` — `## Validation contract` секция
- `packages/fullstack/agents/developer-kotlin.md` — то же
- `packages/fullstack/agents/developer-mobile.md` — то же
- `packages/fullstack/agents/frontend-developer.md` — то же
- `packages/fullstack/package.json` — version bump
- `CHANGELOG.md`, `README.md`

## Open follow-ups (не в этом PR)

1. Pre-implementation `checkpoint: "approve_plan_and_dod"` между
   `discovery` и `implementation` в lightweight/full-feature профилях.
   Сейчас rollup в `team-state.md` уже показывает сколько
   skills/agents/timing, но pre-impl checkpoint — это место где это всё
   должно показываться юзеру.
2. `/pulse` команда должна показывать top-N skills/subagents/error rates
   из observability rollup. Сейчас rollup пишется в `team-state.md`,
   но `/pulse` не парсит его.
3. `qa` агент (через свой же validation_run: true) мог бы тоже стать
   part-of-gate — сейчас gate покрывает только implementation/review_fixes.
4. The `validation_evidence` field should ideally contain structured
   data (build_status, test_count, failures[]) rather than free-form
   text. Out of scope — current text format is parseable enough for the
   gate to validate non-empty.
