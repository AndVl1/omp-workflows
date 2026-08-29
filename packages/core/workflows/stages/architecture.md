# Stage reference: Architecture Design

> Loaded on demand by the `/team` interpreter for the `architecture` stage.
> Governance (classification, interpreter loop, gates, DoD) lives in `commands/team.md`.
> This file holds only the prompt templates / criteria for running the stage.

---

**🚫 Delegate, don't DIY.** Your first action for this stage is the Task call(s). Do NOT read code / run git / grep yourself "to give the agent context" — the agent gathers its own context. Recon-before-delegate is how the orchestrator absorbs the task and the subagent never runs.

### PHASE 4: ARCHITECTURE DESIGN

**Architect count — situational, not fixed (design choice C, pool semantics):**

The stage declares an **allowed pool** — role `architect`, 1..3 occurrences — not a fixed
one-agent-per-role recipe. The orchestrator composes the consilium at `workflow_begin` with a
**semantic selection**: `occurrences: [{ role: "architect", facet, focus, reason }, ...]`.
Concrete agent ids are never part of the selection; the live registered mapping resolves every
selected role, and a missing/disabled registration fails closed.

| situation | composition |
|-----------|-------------|
| default (no selection) | **1** — single `architect`, one design (deterministic engine default) |
| contested design space | **2** — two `architect` slots with distinct facets |
| COMPLEX / high-stakes (`full-feature`) | **up to 3** — parallel option consilium |

Facets are free-form situational labels. The canonical option trio (used as facet/focus, not
roles):

```
{ "role": "architect", "facet": "minimal-change", "focus": "Smallest change, maximum reuse of existing code." }
{ "role": "architect", "facet": "clean-architecture", "focus": "Maintainability, elegant abstractions, testability." }
{ "role": "architect", "facet": "pragmatic-balance", "focus": "Speed + quality balance, reasonable abstractions." }
```

The selection freezes at issuance: re-issuing the identical selection is idempotent; a changed
selection for an active capability is rejected — finish the stage first. Dispatch each frozen
slot (`architect`, `architect#2`, `architect#3`) with its own marker from the handoff.

**Goal**: Design one or several approaches, let the user choose (multi-slot); or propose one (single slot).

1. Review all approaches
2. Form your recommendation based on:
   - Codebase findings
   - User's constraints
   - Task complexity
   - Team context

3. Present to user (one section per frozen slot, in slot order):
   ```
   I've designed N approach(es):

   APPROACH 1: [<facet or slot architect>]
   - [Summary]
   - Pros: [...]
   - Cons: [...]
   - Files: [list]

   APPROACH 2: [<facet or slot architect#2>]
   - [Summary]
   - Pros: [...]
   - Cons: [...]
   - Files: [list]

   MY RECOMMENDATION: Approach [N] because [reasoning]

   Which approach would you like to use?
   ```

**Checkpoint**: ✋ WAIT for user to choose approach

---


### DoD fan-in (source: architecture)

**Append** technical acceptance criteria to `.work-state/artifacts/dod.json`: performance
budgets, API-contract guarantees, failure modes / degradation behavior. Use
`source: "architecture"` and `id: "architecture-<n>"`; bump `updated_at`. Do not renumber
existing items. See `commands/team.md` § Multi-source fan-in.
