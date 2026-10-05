# omp-workflows

Declarative multi-stage workflow engine for [oh-my-pi](https://github.com/oh-my-pi). Native extension package — ships as a workspace of two npm packages:

- **`@andvl1/omp-workflows-core`** — pure engine: state machine, gates, slash commands, profiles, artifact schemas. No agents, no skills, no domain opinions.
- **`@andvl1/omp-workflows-fullstack`** — default bundle of specialized agents and domain skills for Spring/Kotlin/React/KMP/Telegram-bot stacks. Pulls core as a peer dependency.

Custom bundles (Rust, Go-only, minimal Python, etc.) compose core with their own role mappings.

## Install

Packages are published to **GitHub Packages** under `@andvl1`. Configure npm once:

```bash
# ~/.npmrc — points npm at GitHub Packages for the @andvl1 scope.
echo "@andvl1:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=ghp_xxx" >> ~/.npmrc
```

Then install with your usual tooling:

```bash
# Both packages must satisfy the fullstack peer dependency declared in packages/fullstack/package.json.
# Keep published core/fullstack versions on a compatible release line; npm does not
# upgrade core automatically.

# Most projects: core first, then fullstack (engine + agents + skills)
omp plugin install @andvl1/omp-workflows-core
omp plugin install @andvl1/omp-workflows-fullstack

# Engine-only (no agents / skills, build your own)
omp plugin install @andvl1/omp-workflows-core

# Plain npm (works the same — npm respects the registry scoping in ~/.npmrc)
npm install @andvl1/omp-workflows-core
npm install @andvl1/omp-workflows-fullstack
```

For an existing npm-plugin installation, update **both packages to the same
published version**, core first, using `omp plugin install ... --force`.
`omp plugin upgrade` is for marketplace plugins, not npm-installed packages.
Follow the [paired update instructions](packages/fullstack/README.md), then start
a new OMP session to load the updated extensions.

### Приватный runtime этого монорепозитория

В этом worktree `.omp/settings.json` загружает пакет
`packages/omp-workflows-internal` по каноническому workspace-пути, а не через
`node_modules` alias. Указывай каталог пакета, не отдельный `dist/index.js`:
каталог сохраняет discovery приватных агентов и skills. Команды здесь —
`/omp-do-work`, `/omp-team` и `/omp-cto`.

Project override `.omp/plugin-overrides.json` отключает установленный
`@andvl1/omp-workflows-fullstack` только для этого проекта, оставляя один private
workflow owner. Это не отключает gates и не меняет глобальную установку для
других репозиториев. После обновления build или конфигурации полностью перезапусти
OMP; уже загруженные factories и controllers не обновляются от изменений файлов.
Существующий run продолжай через `/omp-do-work --resume --run <run-id>` —
удалять его state или маркеры не требуется.

### Slash command bootstrap and compatibility copies

When the extension is loaded, its registered `/do-work`, `/team`, and `/cto`
commands take precedence over project-local custom-TS copies. A peer-dependency
resolution failure is an install error; a stale compatibility copy is not a
replacement for the unavailable extension implementation.

Project-local `.omp/commands/` copies remain a compatibility path for runtimes that only discover custom-TS commands from disk:

- **`npm install`** — `postinstall` runs `scripts/copy-commands.mjs` and force-copies the shipped files.
- **`omp plugin install`** — npm's `postinstall` does not fire because the package lives in `~/.omp/plugins/`. The extension's `session_start` hook runs a SHA-256-aware sync into `<project>/.omp/commands/`; files unchanged since the previous shipped hash are updated, while user-edited files are preserved.

The sync writes `.omp/commands/.omp-shipped.json` (schema 2) with per-file hashes. The authoritative registered commands are loaded on the next OMP session after a plugin update; the compatibility copies are refreshed at session start.

> **Использование одновременно с Claude Code-плагинами.** Этот пакет и слаг `claude-plugin` (legacy Claude Code-плагин) ставят пересекающийся набор агентов и скиллов. Если вы ставили `claude-plugin` через `claude plugin install`, в omp он подгружается через discovery-provider `claude-plugins` (то же, что `ast-index@ast-index-marketplace`, `figma@claude-plugins-official`, и т. д.). Чтобы не дублировать агентов — отключите provider в `~/.omp/agent/config.yml` одним из способов ниже.

## Отключение дублирующих плагинов

`omp plugin disable` управляет только записями в `~/.omp/plugins/` (omp-marketplace, npm-install, link). Claude Code-плагины, установленные через `claude plugin install` (то есть лежащие в `~/.claude/plugins/`), он не адресует — это отдельный runtime. Для их индексации в omp используется discovery-provider `claude-plugins`, и его можно отключить через `disabledProviders`:

```yaml
# ~/.omp/agent/config.yml — отключить ВСЕ Claude Code-плагины
disabledProviders:
  - claude-plugins
```

Или через CLI:

```bash
omp config set disabledProviders '["claude-plugins"]'
```

Что выключает эта настройка:

- **Agents** — `claude-plugin` больше не индексирует агентов в `/agents` (gate стоит на `isProviderEnabled("claude-plugins")` ДО `listClaudePluginRoots()`, см. `task-agent-discovery.md`).
- **Skills** — скиллы из `claude-plugin` (и всех других Claude Code-плагинов) не попадают в system prompt и не видны через `skill://`.
- **Commands** — slash-команды плагинов не регистрируются.
- **Hooks, MCP, LSP** — от тех же источников тоже отключаются.

Что НЕ отключается:

- omp-runtime плагины (`@andvl1/omp-workflows-*`, `loom` и т. д.) — у них свой provider.
- Bundled-агенты omp (`scout`, `reviewer`, `designer`, `librarian`, `task`, `sonic`).
- Проектные агенты из `<cwd>/.omp/agents/` и пользовательские из `~/.omp/agent/agents/`.

### Точечное отключение — только конкретный плагин

Per-plugin `disabledProviders` не поддерживает — там только id провайдера. Если нужно вырубить только `claude-plugin`, оставив `ast-index`, `figma` и `apple-skills`:

```yaml
# ~/.omp/agent/config.yml
skills:
  ignoredSkills:
    - "claude-plugin"
    - "claude-plugin/**"

task:
  disabledAgents:
    - analyst
    - architect
    - code-reviewer
    - developer-kotlin
    # ... полный список агентов из claude-plugin
```

Имена агентов — плоские (без префикса marketplace), смотрите содержимое `~/.claude/plugins/cache/<marketplace>/claude-plugin/<version>/agents/`.

### Вернуть обратно

```bash
omp config reset disabledProviders
```

или точечно:

```bash
omp config set disabledProviders '[]'
```

Настройка читается на старте сессии; после изменения перезапустите omp или выполните `/reload`.

## Architecture


```
omp-workflows-monorepo/
├── package.json              # workspace root
├── packages/
│   ├── core/                 # @andvl1/omp-workflows-core
│   │   ├── src/
│   │   │   ├── commands/     # do-work, CTO, shared command contracts
│   │   │   ├── runtime-config.ts
│   │   │   └── index.ts      # public APIs: workflow, tool adapter, commands, ownership
│   │   ├── workflows/        # generic declarative profiles + schemas
│   │   ├── test/             # smoke + integration tests
│   │   └── package.json
│   └── fullstack/            # @andvl1/omp-workflows-fullstack
│       ├── src/index.ts            # bundle registration and discovery bootstrap
│       ├── src/workflow-commands.ts # registered /do-work, /team, /cto handlers
│       ├── commands/                # disk-discovery compatibility adapters
│       │   ├── init-team/
│       │   ├── interview/
│       │   ├── omp-model-roles/
│       │   ├── session-report/
│       │   └── workflow-view/
│       ├── agents/                  # domain/team agent definitions
│       ├── skills/                  # domain skill definitions
│       └── package.json
├── .github/workflows/
│   └── release.yml           # tag-driven publish to GitHub Packages
└── vibe-report/              # migration notes, walk reports
```

### Регистрация slash-команд и совместимость

Fullstack регистрирует `/do-work`, `/team` и `/cto` как extension-команды во время
загрузки. Зарегистрированный handler разрешает и авторизует `cwd` сессии, строит
вход workflow и передаёт его через `pi.sendUserMessage(...)`; он сам не запускает
subagents. Затем prompt проходит обычный lifecycle OMP, а resident main agent
вызывает активные `workflow_*` tools.

Core сохраняет canonical state, `workflow_prepare`, execution claims, capability
handoffs, typed artifacts, gates и переходы lifecycle; host agent вызывает эти
инструменты в текущей сессии. Это не обещает background execution или scheduler
без отдельного явно подключённого механизма.

- **Authoritative runtime path:** `packages/fullstack/src/workflow-commands.ts` registers the three workflow handlers through `ExtensionAPI.registerCommand`. OMP gives registered extension commands precedence over project-local custom-TS commands for autocomplete and execution.
- **Compatibility path:** `packages/fullstack/commands/<name>/index.ts` contains the thin custom-TS adapters. `copy-commands.mjs` and the `session_start` SHA-256 sync materialize them under `<project>/.omp/commands/` for runtimes that still rely on disk discovery. These copies are not an override API; same-name external extension commands use OMP's normal load-order rule, and Claude marketplace commands stay namespaced.


### Private OMP internal bundle (this monorepo)

This repository activates a private, workspace-marker-gated bundle — `@andvl1/omp-workflows-internal` — through OMP 18.x's supported project extension setting (`.omp/settings.json#extensions`, resolved relative to the project root). The project extension setting activates **only** `node_modules/@andvl1/omp-workflows-internal`; this monorepo's own development workflow runs entirely on the internal roster (the `omp-*` agent pool — 14 agents, the `omp-feature` / `omp-validate` workflow profiles, and this project's `.omp/team.config.json` / `.omp/teams.json` roster mapping every workflow role onto that pool). Bare `/do-work` `/team` `/cto` come only from a separately installed and active fullstack plugin: when one is present in the host, those bare names still appear in the command inventory next to the `omp-*` names (observed on OMP 18.0.6: `omp-workflow-team`, `omp-do-work`, `omp-team`, `omp-cto` plus `do-work`, `team`, `cto` from the fullstack plugin) — this bundle never registers, owns, or shadows the bare names.

**Activation contract.** The extension loads in every host that reads this project's settings, but workflow-engine registration happens ONLY when the session project root contains all three workspace markers (`package.json` + `packages/core/` + `packages/fullstack/`) — detection is physical-layout only (symlinked markers count as missing) and everything fails closed: no tools, no gates, no runtime-config writes, no owner claims. `/omp-workflow-team validate` is the read-only diagnostic that reports exactly why activation did or did not happen (marker check, current owner claims, agent pool).

**Command surface.**

- `/omp-workflow-team <task>` — bundle-local dispatch; `/omp-workflow-team validate` is strictly read-only.
- `/omp-do-work <task>` (alias `/omp-team`) — the core profile-driven workflow entry point, namespaced for this bundle.
- `/omp-cto <task>` — CTO sub-orchestration; `/omp-cto` alone starts STANDBY.

The namespaced descriptors publish eagerly during extension load (so slash autocomplete sees them), but they are marker-gated: outside a marked workspace the command resolver yields no cwd and the gated owner source refuses the claim, so session start and handlers register **zero** owners and never dispatch a workflow. Inside a marked workspace, `workflow_registration` is claimed first by the command layer and the engine then idempotently claims `workflow_registration`, `workflow_tools`, and `config_writer` under the single `private_omp` owner. Bare `/do-work`, `/team`, and `/cto` names are never registered by this bundle — they stay owned by the external fullstack plugin — and `omp-model-roles` is never shadowed.

**Config ownership.** `.omp/team.config.json` maps roles onto the `omp-*` pool (project-local `regression-*` roles included, remapped onto the pool; custom external plugin agents such as `product-*` preserved verbatim). The engine seeds this file only if absent — user and `/init-team` edits are never overwritten by a session.

### Command routing and consumer overrides

Workflow entry points have two independent ownership layers:

1. **OMP command registry** — maps a slash name to one extension handler. A later
   extension registration can replace the handler for the same canonical name.
2. **Workflow capability registry** — grants one bundle per canonical worktree
   exclusive ownership of `workflow_registration`, `workflow_tools`, and
   `config_writer`. A different bundle cannot replace that owner by registering
   the same slash name; its owner-aware handler fails closed with
   `owner_conflict`.

Стандартные handlers — это ingress: они разрешают `cwd`, строят prompt и вызывают
`pi.sendUserMessage(...)`, но не являются отдельным subagent dispatcher. Resident
main agent выполняет текущий workflow turn через tools активного owner, а engine
проверяет canonical state, claims, capability и typed handoffs. Command ownership и
workflow-capability ownership остаются независимыми слоями.

| Setup | Canonical commands |
|---|---|
| Fullstack bundle only | `/do-work`, `/team`, `/cto` |
| This marked monorepo | `/omp-do-work`, `/omp-team`, `/omp-cto`; `/omp-workflow-team validate` diagnoses the internal owner |
| Two bundles that must coexist | Give each command surface a distinct `commandPrefix` |

In this monorepo a separately installed fullstack extension may make the bare
names visible in autocomplete, but those handlers are not a fallback for the
active internal engine: their fullstack owner claim conflicts with the
`private_omp` owner. Use the `/omp-*` surface here.

Consumer choices:

- Change agents without changing commands through `.omp/team.config.json`
  (`roles`, `scope_map`, `flags`, `roster_overrides`).
- Add a non-conflicting surface with
  `registerWorkflowCommands(pi, { commandPrefix: "rust", ... })`, producing
  `/rust-do-work`, `/rust-team`, and `/rust-cto`.
- Fully replace the default bundle by loading only the custom extension and
  wiring all three core seams: `registerTeamWorkflow`,
  `createWorkflowToolAdapter(...).register(pi)`, and
  `registerWorkflowCommands`. Do not load two different workflow owners and
  depend on extension load order.
- Augment the generated prompt with OMP hooks. Editing copied
  `.omp/commands/do-work`, `team`, or `cto` adapters is not an override API.

The complete custom-bundle recipe is in
[`docs/adding-agents.md`](docs/adding-agents.md#4-регистрация-workflow).


## Usage

/cto Implement a cross-team feature
/do-work Add OAuth authentication with Google and GitHub
/do-work Fix the 500 error on /api/users endpoint
/do-work Review my auth changes
/init-team
> **Note**: `/team` remains a compatibility alias for `/do-work`; `/cto` is the sole orchestration entrypoint.

### Lifecycle: new, resume, rework

Наличие старого state больше не означает автоматическое продолжение. Обычный
workflow использует явные режимы, а UUID нужен только как технический selector:

```text
/do-work --new Добавить экспорт отчётов
/do-work продолжи экспорт отчётов
/do-work --resume
/do-work --resume --run <run-id>
/do-work --rework Исправить результат экспорта
/do-work --list
/do-work --list --all-branches
```

Выбор по названию или пункту read-only списка разрешается в canonical run до
первой мутации. Успешный `workflow_prepare` возвращает receipt с operation,
previous/selected run, статусами и continuation point; неоднозначный выбор
запрашивает уточнение, а ошибочный явный selector не получает fallback.

**Текущий lifecycle обычного `/do-work`:**

- **Prepare и required inputs.** После каждого успешного `workflow_prepare` и
  перехода к следующей стадии host получает текущий contract через
  `workflow_instructions → workflow_begin → workflow_instructions`. Receipt
  обязательных входов привязан к capability; отсутствующий или повреждённый
  required input останавливает действие с `recovery_required`, а не заменяется
  summary, chat history или случайным файлом.
- **Walk profile.** Стадии идут в порядке профиля: `orchestrator` выполняется
  inline, `single` dispatch-ит одного worker, `consilium` dispatch-ит
  объявленный roster (parallel, когда это указано профилем), `document`
  рендерится deterministic engine-ом, `bash` выполняет deterministic shell
  step, `none` пропускается.
- **Artifacts и gates.** `consumes`/`produces` проверяются по typed contracts;
  `gate` и typed checkpoint policy должны быть выполнены до advance. Текст
  `autonomous` и routing metadata не являются разрешением на checkpoint.
  Ограниченные `loop` возвращаются к объявленной стадии только по
  `back_to`/`until`/`max_iterations`, а progress читается из выбранного
  canonical run.
- **Claims и busy.** В одном физическом worktree допускается один
  конфликтующий execution claim. Живой или неизвестно завершённый coordinator
  или worker возвращает `run_busy`; переход не публикуется частично. Сначала
  используйте `workflow_status`: новый run не вытесняет pending work, resume
  присоединяется только к тому же run, а force-unlock не является обходом.
- **Resume и rework.** Resume в новой host-сессии читает canonical state и
  required artifacts, а не старый чат; pending dispatch не запускается повторно,
  а недоступный transport сохраняет `background_wait`/`transport_reconnect`.
  Rework сохраняет прежний результат в immutable revision, переоткрывает
  затронутую стадию с downstream-зависимостями и не позволяет старым proofs
  завершить новую версию.
- **Canonical storage.** Для schema 2 у ordinary run совпадают `run_id`,
  `run_key` и `WorkIdentity.run_id`; state хранится в
  `.work-state/runs/<run-id>/state.json`, revisions — в
  `.work-state/runs/<run-id>/revisions/<revision-id>/`. Branch — контекст
  маршрутизации/совместимости, не identity. Legacy state, slug и
  `.active-feature` остаются import-only и не являются runtime fallback.
- **Canonical report и viewer.** `/session-report` и `/workflow-view` принимают
  selector выбранного canonical run/revision (`/workflow-view --all` — список
  доступных canonical runs). Report пишет self-contained HTML, viewer — offline
  bundle в `.work-state/visualize`; latest/slug/legacy fallback нет. Текущий
  viewer поддерживает canonical reader, а переработка UI/graph model остаётся
  отдельным будущим scope.

Это shipped lifecycle обычного workflow. Автономная маршрутизация не включает
background scheduler и не отменяет typed human checkpoint policy; CTO wave
scheduler — отдельный явно подключаемый/session-scoped механизм, а не implicit
resume.

Подробности про migration/recovery UX, branch context, report и viewer см. в
[`core lifecycle contract`](packages/core/README.md) и
[`fullstack command guide`](packages/fullstack/README.md).

### Сдача результата, approvals и recovery

Producer сдаёт результат через `workflow_submit_result({ outputs })`: ключи
`outputs` — объявленные артефакты текущего назначения, значения — данные их
схем. Identity, роль, slot, run и authority не задаются в model input: core
выводит их из подтверждённого host binding. Запись JSON вручную не заменяет
сдачу результата.

Для больших, вложенных или многострочных результатов при наличии авторизованного программного writer
обязателен `workflow_submit_result({ outputs_path: path })`. Файл имеет ровно формат `{ "outputs": { ... } }`.
Inline остаётся для небольших простых результатов и read-only producers без writer;
их результат должен быть кратким, но полным по схеме. В вызове разрешён ровно один вариант.
Путь относителен к workspace подтверждённого producer; absolute/`..`/symlink запрещены.
Каждый producer occurrence создаёт уникальный файл, не общий `stage-output.json`.
В JS eval: `const path = 'stage-output-' + crypto.randomUUID() + '.json'; await Bun.write(path, JSON.stringify({ outputs }));`.
При разрешённом general Bash используйте Node с `randomUUID` из `node:crypto` и
`writeFileSync(path, JSON.stringify({ outputs }), { flag: 'wx' })` из `node:fs`;
выведите path и передайте именно его в tool. Не собирайте JSON вручную.
После inline parse error переключитесь на файл, если writer разрешён; иначе исправьте
и упростите inline payload без потери обязательных полей. Не повторяйте исследование.
Read-only ast-index-only allowlist не разрешает Node; не обходите ограничения tools.
Только принятый tool receipt подтверждает публикацию. При отказе исправьте файл/вызов без повторного исследования.
Read/path/JSON ошибки возвращают `code`/`error` без `field_errors`; schema ошибки
после чтения идут обычным validation path. Это доставка payload, не восстановление
уже завершённого worker и не новая authority.

- **Producer ownership.** Worker публикует только собственный slot;
  orchestrator — объявленный ему этап. Tool producer использует
  `registerStageProducerTool` и publisher, действующий только внутри
  зарегистрированного callback. Обычный model call не может присвоить себе
  tool authority. `lecture_acquire` сохраняет main-session restriction.
- **Receipt и terminal — разные факты.** Core проверяет схему и evidence,
  публикует immutable payload вместе с receipt и различает точный повтор
  от конфликтующей сдачи. Worker terminal без принятого результата не
  завершает этап; receipt не заменяет worker terminal, DoD или approval.
  Orchestrator/tool не требуют фиктивного worker terminal.
- **Переходы.** Ordinary route использует `workflow_checkpoint_ask` и
  `workflow_advance`. В native CTO root вызывает
  `cto_checkpoint_ask({ slice_id })` и `cto_stage_advance({ slice_id })`;
  configured lead и roster сохраняют собственные границы authority.
  Planning consent не является approval завершённой реализации.
- **Recovery.** `workflow_recover` диагностирует и согласует текущее
  canonical состояние без model-supplied stage token. Неизвестный исход
  worker не является подтверждённым завершением и не разрешает второго
  writer. Format repair возвращается тому же producer, а replacement
  требует подтверждённого исхода и bounded budget.
  Budget привязан к canonical stage/slot lineage, а не к новому SDK session/task:
  restart и повторная доставка не обнуляют использованные попытки. Историческое
  `running` после смены owner не доказывает liveness без свежего host evidence;
  поздний terminal прежнего worker не снимает reservation его replacement.
- **Граница OMP 18.** Continuation через `sendMessage` означает
  `queued`/`not_started`, не запуск worker. Новый dispatch проходит обычный
  admission; только runtime подтверждает start/terminal. Неподтверждённые
  inspect/resume/reconnect capabilities не выдаются за поддерживаемые.
- **Standalone API.** `run`, `runStage` и `createTaskCaller` остаются
  низкоуровневыми API исполнения. `TaskResult` содержит только transport result,
  без `artifacts`; worker публикует `outputs` через свой зарегистрированный
  `workflow_submit_result`. Orchestrator callback возвращает `outputs`, которые
  engine публикует через trusted current-stage binding.
  Registered interpreter передаёт `sessionController` и
  `execution: sessionController.context()`: lifecycle preparation обновляет
  canonical claim и приватную привязку одного controller вместе.
  Несовпадающий controller/context/workspace отклоняется до записи.
  Executor сохраняет реальные SDK admission hooks и child lineage; standalone
  caller без зарегистрированного producer не получает synthetic worker binding.

Для автоматической проверки из корня доступны `npm run test:workflow-scenarios`
(D) и `npm run test:workflow-process` (P). Они используют изолированные roots,
no-network окружение и scenario report с фактическими событиями и source
locators; missing/skipped cases и trace gaps не считаются PASS. Целевые
длительности — D ≤ 60 секунд и P ≤ 180 секунд; фактическое время и соблюдение
бюджета записываются в report. Превышение бюджета завершает команду с ошибкой,
даже если все сценарии прошли. Эти проверки не заменяют отдельные H1/H2/H3
на установленном OMP.
D ограничивает одновременное выполнение тремя test files, P — одним;
длинные файлы запускаются первыми через стандартный `node:test.run`.
Build/typecheck и отдельные тяжёлые команды запускаются последовательно.
Безопасные промежуточные строки содержат только scenario ID, outcome и время,
поэтому зависший gate не скрывает уже завершённые cases до итогового report.

### Bootstrap custom-TS commands into your project

Bootstrapping is automatic for both install paths — see *Slash command bootstrap — works for both install paths* above. The CLI script below remains available for explicit re-sync (for example, after editing a shipped command in the source repo and wanting to refresh a downstream checkout before the next session).

```bash
# Force-copy from a local source checkout (e.g. the monorepo):
npx omp-workflows-copy-commands
# Or from a project where the package lives in node_modules:
npm run --prefix node_modules/@andvl1/omp-workflows-fullstack copy-commands
```

OMP discovers them on the next session start.

## Releases

Авторитетный release-процесс описан в
[`release workflow`](.github/workflows/release.yml): там зафиксированы формат
semver tag, проверка совпадения версии tag с обоими package manifests, CI
проверки, публикация в GitHub Packages и требования к `CHANGELOG.md`. Не
копируйте сюда конкретный version tag — перед публикацией следуйте workflow и
текущему разделу changelog.

## Strict recommendations command (vp9)

`/omp-model-roles recommendations` is a **strict** command: it must
delegate the actual research to the `tech-researcher` subagent
deterministically. The contract relies on a marker envelope plus a
`before_agent_start` extension hook:

1. **Marker contract.** The custom command returns its validate-report
   plus the research prompt wrapped in
   ```text
   <<<omp-model-roles-research-request>>>
   <payload>
   <<<omp-model-roles-research-request-end>>>
   ```
   The literal lines survive `input-controller.ts:665` (`text.trim()`)
   and stay in the user-visible transcript. The marker is opaque to
   OMP — it is detected by our hook, not by the engine.

2. **`before_agent_start` hook.** The default bundle registers a
   handler on `pi.on("before_agent_start", ...)` in
   `packages/fullstack/src/index.ts`. When the marker is present in
   `event.prompt`, the handler returns
   `{ message: { customType, content, display, details, attribution: "agent" } }`
   where `content` is the 4-step developer instruction
   (`Step 1: task(tech-researcher, payload=ResearchRequest)`,
   `Step 2: wait`, `Step 3: strict validation against the immutable
   inventory snapshot`, `Step 4: render a markdown table or a
   degraded-notice`). See
   `packages/fullstack/src/before-agent-start-marker.ts` for the pure
   helpers (`extractPayloadBetweenMarkers`,
   `buildResearchRequestDeveloperInstruction`).

3. **`attribution: "agent"` = developer priority.** OMP's
   `normalizeCustomMessageAttribution` (`session/messages.ts:578-579`)
   treats everything except an explicit `user` as `agent`. The LLM
   processes agent-attributed messages as developer-priority — strictly
   above user-text. This is the key fix for the
   `recommendations_live_5/6/7` regression where the main agent
   ignored the user-prompt delegation request.

4. **Why this is NOT a `/do-work` stage.** The user explicitly chose a
   `before_agent_start` hook over a workflow stage. A new `/do-work` stage would
   couple delegation to the team workflow and force the user to commit to a
   profile. The hook is **session-scoped**, fires once per agent loop, and does
   not create a canonical ordinary workflow run or `.work-state` artifacts.

5. **Fallback for sessions without the extension.** If the
   `@andvl1/omp-workflows-fullstack` extension is not installed (e.g.
   a slim bundle or a custom build), the custom command still emits
   the validate-report + research prompt as plain text. The LLM
   receives the same instruction but without the developer-attributed
   message — i.e. it may ignore the delegation (the original
   failure mode). The hook is a strict upgrade: it never makes
   delegation worse, only better.

## Web search provider configuration

The `tech-researcher` agent calls `web_search` as **Step 1** of
`## External Research — Fresh-Facts (MUST)` — but only in
**Fresh-Facts mode** (benchmarks, model/library versions, release
dates, comparisons — anything needing current dated facts).
Codebase-mode questions (patterns, structure, integration points
inside this repo) skip `web_search` entirely and answer from
`glob`/`grep`/`read`; Documentation-mode questions (how a stable API
or library feature works) use Context7/DeepWiki/official docs first
with `web_search` optional. See `## Research Modes` in
`packages/fullstack/agents/tech-researcher.md`. The runtime depends
on OMP's `web_search` tool resolving to a working provider.

### Free providers (no signup, may be bot-challenged)

| Provider | Notes |
|----------|-------|
| `duckduckgo` | Default. May rate-limit or CAPTCHA in CI or shared IPs. |
| `ecosia` | Fallback. Same bot-challenge risk as DuckDuckGo. |
| `google-scrape` | Read-only scrape. Bot-challenged aggressively. |

Free providers are good for ad-hoc lookups, but for production
research the agent may degrade to MCP fallback (Context7, DeepWiki)
when the search returns `Error: No web search provider configured.`
or empty sources. See `## External Research — Fresh-Facts (MUST) → Step 2:
Degraded-notice` in `packages/fullstack/agents/tech-researcher.md`.

### Paid providers (reliable quality, requires auth)

| Provider | Login command | Environment variable |
|----------|---------------|----------------------|
| `google-gemini-cli` | `omp /login google-gemini-cli` | `GEMINI_API_KEY` |
| `exa` | `omp /login exa` | `EXA_API_KEY` |
| `brave` | `omp /login brave` | `BRAVE_API_KEY` |
| `perplexity` | `omp /login perplexity` | `PERPLEXITY_API_KEY` |
| `tavily` | `omp /login tavily` | `TAVILY_API_KEY` |

Pick **Gemini** (`google-gemini-cli`) for the best
price/performance — it returns structured snippets suitable for
benchmark extraction. **Exa** is a strong alternative with native
neural search.

Set the env var in `.env` or your shell; OMP picks it up on the next
session start. Login commands persist credentials in the OMP auth
storage and survive session restarts.

### Diagnose via `/omp-model-roles validate`

The custom command's `validate` action reports
`web_search=enabled|disabled|unknown` in the report header and adds
an `INFO:` / `WARN:` line that explains what is and is not
observable from a custom-command context:

```text
/omp-model-roles validate (14 available models, web_search=enabled)
role | agents | fallback | status | config-value | source
...
INFO: web_search.enabled=true; provider availability is NOT observable
      from /omp-model-roles (HookCommandContext lacks authStorage/ToolSession).
      Run `omp /login google-gemini-cli` or set GEMINI_API_KEY for reliable
      quality; free providers (duckduckgo/ecosia) may be bot-challenged.
```

The header suffix is the source of truth for the toggle. The body
warning tells you that **runtime provider availability** (e.g. is
the Gemini key valid right now?) cannot be probed from
`HookCommandContext` — `authStorage` and `ToolSession` are not part
of that surface (see `hooks/types.ts:178-191`). For a real
provider probe, run the agent and read its `Degraded Notices` block.


For a custom bundle, do not treat `registerTeamWorkflow` as the complete
extension entry point: it wires gates/config/observability, but not the
`workflow_*` tools or slash commands. Compose all three seams under one owner
identity as shown in
[`docs/adding-agents.md`](docs/adding-agents.md#4-регистрация-workflow).

Passing `getSessionController` to `registerTeamWorkflow` also requires the
bundle's `resolveTrustedToolCallActor`; an incomplete pair fails at registration
with `[workflow_registration:missing_actor_resolver]`. An authenticated idle
host is distinct from an unknown caller, even when no workflow is selected.
Admission failures include a stable `[workflow_admission:<code>]`, an action,
and safe report guidance. See the
[host/session contract and troubleshooting guide](docs/adding-agents.md#hostsession-authority--обязательный-контракт)
before upgrading a custom bundle; do not bypass admission by removing its
controller or trusting raw `actor`/`hasUI` fields.

## Observability

When the engine is wired in via `registerTeamWorkflow`, it subscribes to seven OMP extension events
(`before_agent_start`, `agent_start`, `agent_end`, `tool_call`, `tool_result`,
`session_start`, `session_stop`) and records events only for the explicitly selected
canonical run. Live hooks use the explicit canonical run ID and write
`.work-state/runs/<run-id>/observability/events.jsonl`; revisions are read-only immutable
snapshots, while live hook scope remains the parent run ID.
Feature-slug, branch-derived and `.active-feature` recorder scopes are not a runtime
fallback and return migration guidance.

The rollup is persisted in the selected `TeamState.observability` pointer and is consumed by
the canonical status/report readers:

```markdown
## Observability
- events: observability/events.jsonl (last id: evt-l8v3kf72-1b)
- agent invocations: 4
- subagents: developer-go (1), code-reviewer (1), qa (1)
- skills: ast-index (3), omp-workflows (2)
- tool calls: 47 (errors: 2)
- duration: 1842000ms
```

This is the source of truth for:
- **Which subagents ran** (and how long their parent calls blocked on the
  result) — without parsing the OMP session jsonl.
- **Which skills were active** during each agent loop — scanned from the
  system prompt via `skill://<name>` URIs.
- **Tool-level failure rates** — useful for catching a subagent that emits
  broken code (compile errors surface as `tool_result.isError`).

Disable per-bundle via `registerTeamWorkflow(pi, { observability: false })`.
Pre-observability features yield an absent `TeamState.observability` field
(no migration needed).

## Subagent validation contract

Stages that produce a code-bearing artifact (`implementation`,
`review_fixes`) go through a machine-checked validation gate after the
subagent returns. The handoff is blocked unless the artifact contains:

- `ready: true` or `"true"`
- `validation_run: true` or `"true"`
- `validation_evidence`: a non-empty string claiming actual validation output
  or provenance. The gate does not machine-verify that claim.

A missing or invalid validation block is a typed stage-readiness blocker, not a
worker failure. Preserve any succeeded terminal receipt; do not patch the
artifact, reuse its authorization, or re-run/re-spawn a worker in the same
turn. Continue only through explicit lifecycle rework with a fresh capability;
replacement output must carry actual validation output or provenance.

Why: in production we observed subagents returning
`ready: true, validation_run: "false", validation_note: "Per assignment,
orchestrator owns validation"`. The "per assignment" was an LLM hallucination —
the assignment said no such thing. There is no escape hatch in the engine. The
gate is the source of truth.

If a profile uses the stage id `implementation` or `review_fixes` for a
non-code stage, it must either satisfy this validation contract or use a
different stage id; the gate is keyed by those stage ids.

## Orchestrator discipline

The orchestrator (the main agent driving the workflow) is a
**dispatcher**, not a coder:

- It does not edit source code. If a dispatched worker actually fails or is
  cancelled and the profile permits another dispatch, follow the declared
  lifecycle path; do not patch the worker's artifact.
- It does not second-guess build/test output by re-running it. The worker owns
  the validation evidence; the orchestrator either accepts it or uses the
  explicit lifecycle rework path.
- It does not skip stages to "save time". The profile order is the
  contract.
- On a stage-readiness gate failure after a successful worker result, it preserves
  the receipt and waits for explicit lifecycle rework; it does not re-spawn or
  retry the worker in the same turn.

These rules are documented in the `/do-work` command prompt and injected
into the stage prompt for every executor via `buildStagePrompt`.

## Migration from `claude-plugin`

A custom replacement for the fullstack bundle must own the complete workflow
surface — gates/config, tool adapter, and commands — rather than calling only
`registerTeamWorkflow`. Follow the
[`custom-bundle registration recipe`](docs/adding-agents.md#4-регистрация-workflow)
and disable the old bundle instead of relying on same-name command load order.

Same data (JSON profiles, typed artifacts, agent names, skill names) — same `.work-state/` files. The interpretive prose (`commands/team.md`, 830 lines) is now TypeScript in `core/src/`. The bash hooks (`validate-state.sh`, `dod-gate.sh`, `safety-guard.sh`) are now event handlers in `core/src/gates/`. Documented in `vibe-report/omp-workflows-migration-2026-07-31.md`.

## License

MIT.
