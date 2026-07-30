# omp-workflows

Declarative multi-stage workflow engine for [oh-my-pi](https://github.com/oh-my-pi). Native extension package — ships as a workspace of two npm packages:

- **`@omp-workflows/core`** — pure engine: state machine, gates, slash commands, profiles, artifact schemas. No agents, no skills, no domain opinions.
- **`@omp-workflows/fullstack`** — default bundle: 15 specialized agents + 32 domain skills for Spring/Kotlin/React/KMP/Telegram-bot stacks. Pulls core as a peer dependency.

Custom bundles (Rust, Go-only, minimal Python, etc.) compose core with their own role mappings.

## Install

```bash
# Most projects: fullstack (engine + agents + skills)
omp plugin install @omp-workflows/fullstack

# Engine-only (no agents / skills, build your own)
omp plugin install @omp-workflows/core

# Custom (replace defaultFullstackRoles with your own roster)
npm install @omp-workflows/core
```

## Architecture

```
omp-workflows-monorepo/
├── package.json              # workspace root
├── packages/
│   ├── core/                 # @omp-workflows/core
│   │   ├── src/
│   │   │   ├── engine/       # state, profile, stage, classify, scope, config, dod
│   │   │   ├── gates/        # classification, monotonic, dod-backstop, safety
│   │   │   ├── commands/     # team, pulse, team-next, team-yolo, init-team, ...
│   │   │   ├── runtime-config.ts
│   │   │   └── index.ts      # public API: registerTeamWorkflow(pi, opts)
│   │   ├── workflows/        # 8 declarative JSON profiles + schemas
│   │   ├── test/             # smoke + integration tests
│   │   └── package.json
│   └── fullstack/            # @omp-workflows/fullstack
│       ├── src/
│       │   └── index.ts      # default export: registerTeamWorkflow(pi, defaultFullstackRoles, ...)
│       ├── agents/           # 15 agent markdown files
│       ├── skills/           # 32 domain skills
│       └── package.json
└── vibe-report/              # migration notes, walk reports
```

## Usage

```bash
/team Add OAuth authentication with Google and GitHub
/team Fix the 500 error on /api/users endpoint
/team Review my auth changes
/pulse
/init-team
/team-yolo
```

## How it works

`/team <task>` walks:

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

Gates run as `before_agent_start` (classification + monotonic), `session_stop` (DoD backstop), and `tool_call` (safety). Workflow data is the same JSON files as the legacy `claude-plugin` (v3.0.x). The interpreter moves from markdown prose into TypeScript.

## Custom bundles

```typescript
// your-package/src/index.ts
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerTeamWorkflow } from "@omp-workflows/core";

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
