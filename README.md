# omp-workflows

Declarative multi-stage workflow engine for [oh-my-pi](https://github.com/oh-my-pi). Native extension package — ships as a workspace of two npm packages:

- **`@andvl1/omp-workflows-core`** — pure engine: state machine, gates, slash commands, profiles, artifact schemas. No agents, no skills, no domain opinions.
- **`@andvl1/omp-workflows-fullstack`** — default bundle: 17 specialized agents + 31 domain skills for Spring/Kotlin/React/KMP/Telegram-bot stacks. Pulls core as a peer dependency.

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
# Most projects: fullstack (engine + agents + skills)
omp plugin install @andvl1/omp-workflows-fullstack

# Engine-only (no agents / skills, build your own)
omp plugin install @andvl1/omp-workflows-core

# Plain npm (works the same — npm respects the registry scoping in ~/.npmrc)
npm install @andvl1/omp-workflows-fullstack

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
    - coordinator
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
│   │   │   ├── engine/       # state, profile, stage, classify, scope, config, dod
│   │   │   ├── gates/        # classification, monotonic, dod-backstop, safety
│   │   │   ├── commands/     # team.ts (legacy envelope), shortcuts.ts
│   │   │   ├── runtime-config.ts
│   │   │   └── index.ts      # public API: registerTeamWorkflow(pi, opts)
│   │   ├── workflows/        # 8 declarative JSON profiles + schemas
│   │   ├── test/             # smoke + integration tests
│   │   └── package.json
│   └── fullstack/            # @andvl1/omp-workflows-fullstack
│       ├── src/
│       │   └── index.ts      # default export: registerTeamWorkflow(pi, defaultFullstackRoles, ...)
       ├── commands/         # 8 OMP custom-TS slash commands (do-work, pulse, team-next, ...)
       │   ├── do-work/      # orchestrates /do-work: classify → resolve → return prompt
       │   ├── team/         # thin alias for /do-work (kept for backwards compatibility)
       │   ├── pulse/        # read-only project digest
       │   ├── team-next/    # pop next queued task
       │   ├── team-yolo/    # [AUTONOMOUS] wrapper
       │   ├── init-team/    # write .omp/team.config.json
│       └── coordinator-stats/  # profile-usage rollup
│       ├── scripts/          # copy-commands.mjs — installs commands into .omp/commands/
│       ├── agents/           # 17 agent markdown files
│       ├── skills/           # 31 domain skills
│       └── package.json
├── .github/workflows/
│   └── release.yml           # tag-driven publish to GitHub Packages
└── vibe-report/              # migration notes, walk reports
```

### How slash commands ship (v0.4.0+)

OMP 17.x exposes the `task` tool only to the main agent — neither
extension commands nor custom-TS commands can drive subagent dispatch
directly. So as of v0.4.0, the workflow engine splits cleanly:

- **Extension** (`packages/fullstack/src/index.ts`) registers gates and
  writes the runtime config. It does **not** register slash commands.
- **Custom-TS commands** (`packages/fullstack/commands/<name>/index.ts`)
  ship as OMP custom-TS commands. Each parses the envelope, reads
  `.omp/team.config.json`, and returns a prompt the main agent runs
  through its own `task` tool.
- **`copy-commands.mjs`** (run after install) copies the bundled commands
  into `<project>/.omp/commands/` so OMP can discover them.

Custom-TS commands receive `HookCommandContext` (ui, cwd, sessionManager,
modelRegistry) — they can NOT call `task` directly. They either:

1. Return a string prompt (the main agent runs the workflow through its own `task` tool), or
2. Inspect filesystem state and return a digest (the LLM or user acts on it).


## Usage

/do-work Add OAuth authentication with Google and GitHub
/do-work Fix the 500 error on /api/users endpoint
/do-work Review my auth changes
/do-work Add a small CLI flag  (works in non-git directories)
/pulse
/init-team
/team-yolo
> **Note**: `/team` is shipped as an alias for `/do-work` for muscle-memory compatibility; both commands resolve to the same workflow.
## How it works
`/do-work <task>` walks (same as `/team`):

1. **Classify** the request → `Classification = {type, complexity, confidence, workflow}`.
2. **Resolve** the profile via the `Type × Complexity → Workflow` table.
3. **Write** `.work-state/team-state.json` BEFORE any subagent launch (the gate blocks otherwise).
4. **Walk** stages in profile order. Each by `type`:
   - `orchestrator` → inline orientation
   - `single` → one `task` call
   - `consilium` → parallel `task` calls in one batch
   - `bash` → deterministic shell step
   - `none` → skip
5. **Honour** `consumes`/`produces` typed artifacts.
6. **Honour** `gate` (block `done` until gate holds) and `checkpoint` (interactive: stop; autonomous: apply `autonomous` decision).
7. **Loop** if `loop: { back_to, until, max_iterations }` is set.
8. **Mirror** progress into `team-state.md`.

Concretely, in v0.4.0+:
- The `/do-work` custom-TS command (or its `/team` alias) parses the envelope and returns a prompt
  to the main agent with the resolved `Workflow:` name and the role
  mapping table.
- The main agent then runs the `task` tool with the resolved agent for
  each stage. The engine is the *grammar* of the workflow; the main
  agent owns the *runtime*.

Gates run as `before_agent_start` (classification + monotonic), `session_stop`
(DoD backstop), and `tool_call` (safety). Workflow data is the same JSON
files as the legacy `claude-plugin` (v3.0.x). The interpreter moves from
markdown prose into TypeScript.

### Bootstrap custom-TS commands into your project

```bash
# After `npm install @andvl1/omp-workflows-fullstack`:
npm run --prefix node_modules/@andvl1/omp-workflows-fullstack copy-commands
# Or:
npx omp-workflows-copy-commands
```

Either command copies the 7 slash commands into `.omp/commands/` of the
current directory. OMP will discover them on the next session start.

If you don't run this, the extension still wires gates/roles — only the
slash commands are missing.

## Release

Releases are driven by pushing a semver tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` then runs `npm ci`, full monorepo build, typecheck, tests, stamps `packages/{core,fullstack}/package.json#version` from the tag, and publishes `@andvl1/omp-workflows-core` then `@andvl1/omp-workflows-fullstack` to `npm.pkg.github.com` as `--access public`. `GITHUB_TOKEN` is sufficient; the `AndVl1/omp-workflows` repo is public so its tokens carry `packages: write` for the org.

## Custom bundles

```typescript
// your-package/src/index.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerTeamWorkflow } from "@andvl1/omp-workflows-core";

const MY_ROLES = {
  architect: "my-architect",
  backend: "my-go-backend",
  tester: "my-qa",
};

export default function (pi: ExtensionAPI) {
  registerTeamWorkflow(pi, {
    label: "my-team",
    roles: MY_ROLES,
  });
}
```

## Migration from `claude-plugin`

Same data (JSON profiles, typed artifacts, agent names, skill names) — same `.work-state/` files. The interpretive prose (`commands/team.md`, 830 lines) is now TypeScript in `core/src/`. The bash hooks (`validate-state.sh`, `dod-gate.sh`, `safety-guard.sh`) are now event handlers in `core/src/gates/`. Documented in `vibe-report/omp-workflows-migration-2026-07-31.md`.

## License

MIT.
