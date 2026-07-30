# omp-workflows monorepo split — 2026-07-31

## What changed

`omp-workflows` (single package) → `omp-workflows-monorepo` (workspace with two packages).

| Before | After |
|--------|-------|
| `omp-workflows/src/{engine,gates,commands,index.ts}` | `@omp-workflows/core/src/{engine,gates,commands,index.ts}` |
| `omp-workflows/agents/` | `@omp-workflows/fullstack/agents/` |
| `omp-workflows/skills/` | `@omp-workflows/fullstack/skills/` |
| `omp-workflows/workflows/` | `@omp-workflows/core/workflows/` |
| `omp-workflows/.omp-plugin/marketplace.json` | (deferred — publishing to marketplace is a separate step) |
| Hard-coded agent entries in `src/index.ts` | `registerTeamWorkflow(pi, opts)` public API + `defaultFullstackRoles`/`defaultFullstackModels`/etc. |

## Architectural fixes during the split

1. **Shared `CommandContext`**: `commands/team.ts` and `commands/shortcuts.ts` had two divergent `CommandContext` types. Consolidated into `commands/types.ts`. The `TaskCaller` interface from `engine/stage.ts` is now the canonical shape.

2. **Public API surface**: `core/src/index.ts` no longer assumes agents/skills. It exports `registerTeamWorkflow(pi, opts)` which any bundle can call. The fullstack package is now 21 lines — pure adapter.

3. **Default role config moved into core**: `DEFAULT_ROLES`, `DEFAULT_MODELS`, `DEFAULT_SCOPE_MAP`, `DEFAULT_FLAGS` constants are exported as `defaultFullstackRoles` etc. for bundles to use. Custom bundles bring their own through `opts.roles`.

4. **`RunOptions` extended**: added `issue?: { number, url? } | null` (already supported by `team.ts` but missing from `RunOptions`). Added optional `pause`/`log` callbacks with safe defaults.

5. **Test harness**: `packages/core/test/smoke.test.ts` covers the public API. 9 tests passing — profile loading, workflow resolution, role/model defaults, gate registration, command subset, fullstack bundle import.

## How consumers install

```bash
# Default fullstack team
npm install @omp-workflows/fullstack @omp-workflows/core

# Engine-only (own roles)
npm install @omp-workflows/core
```

Peer dependencies handle the rest. `npm install` resolves both via workspace symlinks.

## What still needs work

- **Marketplace packaging**: `.omp-plugin/marketplace.json` for omp's `omp plugin install` flow. Currently the install is via npm (`omp` doesn't yet have a `requires:` field for marketplace auto-pull).
- **End-to-end test against real omp runtime**: the smoke test verifies API shape but the `TaskCaller` interface is still a stub — production runs go through `pi.task()` which the smoke test can't reach.
- **Custom bundle example**: would be nice to ship `packages/minimal` showing 3-role custom override. Future task.
