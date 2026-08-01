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

### Slash command bootstrap — works for both install paths

OMP's `discoverCustomCommands` only scans project-local `.omp/commands/<name>/index.ts`; it does **not** read the installed plugin's `node_modules` directly. The shipped slash commands must land in `<project>/.omp/commands/` for OMP to find them. Two paths cover every install mode:

- **`npm install`** — the package's `postinstall` script runs `scripts/copy-commands.mjs` and force-copies the commands.
- **`omp plugin install`** — npm's `postinstall` does *not* fire (the package lives in `~/.omp/plugins/`, outside any project's `node_modules`). The `@andvl1/omp-workflows-fullstack` extension listens for `session_start` and calls `ensureCommandsForSession` which copies anything missing — leaving your local edits untouched. The first OMP session in each project materialises the commands automatically; no manual run is needed.

The `session_start` path is conservative (it never overwrites existing files), the `postinstall` path is destructive (it overwrites so reinstalls can repair drift). Both produce the same `<project>/.omp/commands/` layout.

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

Bootstrapping is automatic for both install paths — see *Slash command bootstrap — works for both install paths* above. The CLI script below remains available for explicit re-sync (for example, after editing a shipped command in the source repo and wanting to refresh a downstream checkout before the next session).

```bash
# Force-copy from a local source checkout (e.g. the monorepo):
npx omp-workflows-copy-commands
# Or from a project where the package lives in node_modules:
npm run --prefix node_modules/@andvl1/omp-workflows-fullstack copy-commands
```

OMP discovers them on the next session start.

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

## Observability (v0.7.0+)

When the engine is wired in via `registerTeamWorkflow`, it subscribes to seven OMP extension events
(`before_agent_start`, `agent_start`, `agent_end`, `tool_call`, `tool_result`,
`session_start`, `session_stop`) and writes a per-feature append-only event log
to `.work-state/features/<slug>/observability/events.jsonl`. A rollup
is computed from the log and embedded in `TeamState.observability` on
every `writeState`.

The rollup is mirrored in `team-state.md` under a new `## Observability` section:

```markdown
## Observability
- events: observability/events.jsonl (last id: evt-l8v3kf72-1b)
- agent invocations: 4
- subagents:
  - developer-go: 1
  - code-reviewer: 1
  - qa: 1
- skills:
  - ast-index: 3
  - omp-workflows: 2
- tool calls: 47 (errors: 2)
- duration: 1842000ms (2026-08-01T13:00:00Z → 2026-08-01T13:30:42Z)
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

## Subagent validation contract (v0.8.0+)

Stages that produce a code-bearing artifact (`implementation`,
`review_fixes`) go through a machine-checked validation gate after the
subagent returns. The handoff is blocked unless the artifact contains:

- `ready: "true"`
- `validation_run: "true"` (the string, not the boolean)
- `validation_evidence`: the verbatim stdout/stderr of the project's
  build + test commands — not a summary, not "ok", the actual output.

A subagent that returns `ready: true` without these is **rejected** with
a precise reason. The stage is marked `failed` and the orchestrator must
re-spawn the developer with the gate's reason as the new task. The
orchestrator is forbidden from patching the artifact by hand, from
editing source code, or from re-running the subagent's build to "double
check".

Why: in production we observed subagents returning
`ready: true, validation_run: "false", validation_note: "Per assignment,
orchestrator owns validation"`. The "per assignment" was an LLM
hallucination — the assignment said no such thing. There is no
escape hatch in the engine. The gate is the source of truth.

Profiles that re-use the `implementation` or `review_fixes` produce keys
for non-code stages must either rename the produces key or include the
validation fields; otherwise the stage will be marked `failed`.

## Orchestrator discipline

The orchestrator (the main agent driving the workflow) is a
**dispatcher**, not a coder:

- It does not edit source code. If a subagent's output is wrong, the
  orchestrator re-spawns the same agent with a sharper task. It does
  not patch the subagent's artifact.
- It does not second-guess build/test output by re-running it. The
  subagent owns the validation evidence; the orchestrator either trusts
  it or re-spawns.
- It does not skip stages to "save time". The profile order is the
  contract.
- On a validation-gate failure, the orchestrator's only job is to call
  the same agent again with the gate's reason (the stage outcome's
  `note` field) as the new task, copied verbatim.

These rules are documented in the `/do-work` command prompt and injected
into the stage prompt for every executor via `buildStagePrompt`.
</input>

## Migration from `claude-plugin`
</input>

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
