# omp-workflows

Declarative multi-stage workflow engine for [oh-my-pi](https://github.com/oh-my-pi). Native extension package — ships as a workspace of two npm packages:

- **`@omp-workflows/core`** — pure engine: state machine, gates, slash commands, profiles, artifact schemas. No agents, no skills, no domain opinions.
- **`@omp-workflows/fullstack`** — default bundle: 17 specialized agents + 31 domain skills for Spring/Kotlin/React/KMP/Telegram-bot stacks. Pulls core as a peer dependency.

Custom bundles (Rust, Go-only, minimal Python, etc.) compose core with their own role mappings.

## Install

Packages are published to **GitHub Packages** under `@omp-workflows`. Configure npm once:

```bash
# ~/.npmrc — points npm at GitHub Packages for the @omp-workflows scope.
echo "@omp-workflows:registry=https://npm.pkg.github.com" >> ~/.npmrc
echo "//npm.pkg.github.com/:_authToken=ghp_xxx" >> ~/.npmrc
```

Then install with your usual tooling:

```bash
# Most projects: fullstack (engine + agents + skills)
omp plugin install @omp-workflows/fullstack

# Engine-only (no agents / skills, build your own)
omp plugin install @omp-workflows/core

# Plain npm (works the same — npm respects the registry scoping in ~/.npmrc)
npm install @omp-workflows/fullstack
```

> **Note on duplicates.** If you also have the sibling `claude-plugin` installed (it ships overlapping agent + skill markdown for Claude Code), disable it in omp to avoid duplicate commands and agents: `omp plugin disable claude-plugin`. The filters live in omp core; `@omp-workflows/fullstack` does not and cannot control other plugins from inside its own extension runtime.

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
│       ├── agents/           # 17 agent markdown files
│       ├── skills/           # 31 domain skills
│       └── package.json
├── .github/workflows/
│   └── release.yml           # tag-driven publish to GitHub Packages
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

## Release

Releases are driven by pushing a semver tag:

```bash
git tag v0.2.0
git push origin v0.2.0
```

`.github/workflows/release.yml` then runs `npm ci`, full monorepo build, typecheck, tests, stamps `packages/{core,fullstack}/package.json#version` from the tag, and publishes `@omp-workflows/core` then `@omp-workflows/fullstack` to `npm.pkg.github.com` as `--access public`. `GITHUB_TOKEN` is sufficient; the `AndVl1/omp-workflows` repo is public so its tokens carry `packages: write` for the org.

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
