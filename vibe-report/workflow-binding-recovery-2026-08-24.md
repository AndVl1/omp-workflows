# Workflow binding recovery

Date: 2026-08-24
Branch: `fix/workflow-binding-recovery`
Commit: `cee3899` (pushed to `origin`)

## Completed task

Recovered workflow binding for the affected dispatch path and documented the regression coverage.

## Root cause

The `run_key` was normalized opaquely from `fix/sync-secrets-before-restart` to hyphen form. In addition, the dispatch marker was omitted from each `tasks[].task`. The strict engine rejection is correct: the submitted task bindings did not satisfy the required dispatch contract.

## Changes

- Updated `packages/core/src/commands/do-work.ts`.
- Updated `packages/fullstack/src/index.ts`.
- Added or updated regression tests covering the corrected workflow binding and dispatch marker behavior.

## Verification

- `npm run build:core` — passed.
- `npm run build:fullstack` — passed.
- Core regression suite — 45 passed.
- Fullstack regression suite — 268 passed.
- `git diff --check` — passed.

No `cc-proxy` or production files were changed.
