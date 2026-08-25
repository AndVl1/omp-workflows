# Nested subagents in `/subagents` HUD

Date: 2026-08-25  
Branch: `fix/subagent-tree-nested-agents`

## Problem

The fullstack `/subagents` HUD showed only the directly spawned `team-lead`, while OMP's built-in Agent Hub showed both the lead and its nested worker.

## Root cause

Task lifecycle and progress events are emitted through a session-local EventBus. The main-session extension receives events for direct children, but nested workers emit lifecycle events on their parent agent's EventBus. OMP's built-in Agent Hub does not have this gap because it reads the process-global `AgentRegistry`.

## Fix

- Reconcile HUD membership and parent/child lineage from the process-global `AgentRegistry`.
- Use `AgentRegistry.parentId` as the authoritative lineage field.
- Keep `parentToolCallId` only as inline-card metadata.
- Retain the EventBus for rich live progress deltas where the main session already receives them.
- Dispose registry/EventBus subscriptions and timers when the controller or session is replaced.
- Create the live widget only for the main session.
- Add regression coverage for registry-discovered nested workers and listener cleanup.

## Verification

- Targeted tests: 26 passed.
- Fullstack typecheck: passed.
- Fullstack and E2E harness builds: passed.
- Canonical live E2E: passed on OMP 18.0.4 with the current package loaded through `--extension packages/fullstack`.
  - `CanonicalLead` was registered as `team-lead`.
  - `CanonicalLead.CanonicalWorker` was registered as its nested `task` worker.
  - Agent Hub reported `2 running` and rendered the worker beneath the lead.
  - `/subagents expanded` rendered `Subagents (2)` with the same `team-lead → task` hierarchy.
  - The worker executed `sleep 45` in 45.01 seconds and yielded.
  - The lead consumed the completed worker result and yielded naturally after 1m06s.

The persistent E2E checklist is `vibe-report/subagent-tree-nested-agents-e2e-scenario.md`.

## Tracking

Bead `br-yho` is closed as completed.
