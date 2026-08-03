# Task: run `/omp-model-roles recommendations` and report the table

You are working in a fresh scratch project created by `ux-e2e bootstrap`,
wired to the omp-workflows plugin (branch `feat/agent-model-roles`). The
plugin ships a `/omp-model-roles` command with two subcommands:
`validate` (already exercised in earlier runs) and `recommendations`.

## Requirement — a single, non-negotiable instruction

When this task starts, the very first thing you MUST do is type the
following command in the prompt and submit it (Enter):

    /omp-model-roles recommendations

That command is expected to:
1. Print an interpreter prompt string (a self-contained instruction that
   starts with the literal first line `You MUST execute the steps below
   EXACTLY...`).
2. Tell you to delegate research to a sub-agent. The expected delegation
   pattern is roughly `task(agent: "tech-researcher", ...)` plus one or
   more `web_search` calls. The sub-agent should return a markdown table
   mapping each role (`architect`, `developer-go`, `qa-tester`,
   `code-reviewer`, etc.) to a recommended model + URL sources.

## What you MUST do — step by step

1. Submit `/omp-model-roles recommendations` as your first action.
2. Read whatever the command prints. If it returned a string-prompt with
   `You MUST execute the steps below EXACTLY...`, follow it: delegate
   the research to `task(agent: "tech-researcher", ...)`. The sub-agent
   has the budget to run `web_search` and look up current models.
3. After the sub-agent finishes, render the resulting table in your
   final assistant message (markdown table: role | recommended model |
   source URLs).
4. Do NOT spend time re-reading the scratch directory, scanning your own
   work-state, or running local grep/python — the research is the
   delegation's job. If the command asks you to spawn a sub-agent,
   spawn it.

## Acceptance

- The final assistant message must contain a markdown table whose
  columns are role / recommended model / source(s).
- A sub-agent of class `tech-researcher` must have been spawned
  (`task(agent: "tech-researcher", ...)`).
- `web_search` was used by the sub-agent to look up current models.

If the command's string-prompt cannot be obtained (no `/omp-model-roles`
present), report exactly what the command printed and exit. Do not
fabricate a table.