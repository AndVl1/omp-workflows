# UX E2E Report — ux-e2e-reference2

**Verdict:** CONDITIONAL  
**Overall:** 4.0/5 — ship  
**Generated:** 2026-08-02T02:34:43.319Z

## Session

- slug: `ux-e2e-reference2`
- scratch dir: `/tmp/omp-ux-e2e-ux-e2e-reference2`
- omp version: `omp/17.2.3`
- profile: `ux-e2e-test`
- tty: `100x30 xterm-256color`
- started: `2026-08-02T02:26:12.322Z`
- finished: `n/a`
- scenario: `full-feature` — Full workflow: discovery -> exploration -> clarify -> architecture -> implementation -> review -> manual QA

### Task prompt

```
# Task: implement the feature described in the task prompt

Implement the feature described in the task prompt in the ux-e2e-scratch project on branch feat/my-feature.

You are working in a fresh scratch project created by `ux-e2e bootstrap`. Run the
workflow exactly as you would for a real change: ask clarifying questions when the
requirements are ambiguous, and keep the change as small as reasonable.

## Requirements

- Follow the repository conventions (CLAUDE.md, team config) — this project is
  wired to the omp-workflows plugin.
- Deliver production-quality code, with tests where the conventions require them.
- The scope should cover the requested surface (web / cli / mobile) as clarified by the user — clarify what is in scope if the team
  config leaves it ambiguous.
- Prefer boring, well-structured solutions over clever ones.
- Update the changelog and any docs the conventions require.

## Out of scope (unless clarified otherwise)

- Anything beyond the requested surface (web / cli / mobile) as clarified by the user.
- Infrastructure changes not required by the feature.

## Notes

- The session time budget is 30m; use it wisely.
- If a requirement is underspecified (e.g. which platforms, how deep the scope),
  ask the user before proceeding — do not guess silently.

```

## Overall

**Score:** 4.0/5  
**Recommendation:** ship

Framework end-to-end works (D1/D2/D3 all verified live; D4 fix present and partially effective — host config inherited but environment lacks API keys). Coverage stops at the boot stage because omp's model discovery fails on missing credentials (environment, not framework).

## Steps

| # | Step | Rating | Defects |
|---|------|--------|---------|
| 0 | Build e2e package + CLI sanity | message_clarity: 5, feedback_timing: 5, error_handling: 5, layout: 5, interactivity: 5, visual_rendering: 5 | — |
| 1 | Bootstrap fresh scratch project | message_clarity: 5, feedback_timing: 5, error_handling: 5, layout: 5, interactivity: 5, visual_rendering: 5 | — |
| 2 | Start with --detach (D2 verification) | message_clarity: 4, feedback_timing: 4, error_handling: 4, layout: 4, interactivity: 4, visual_rendering: 4 | FD-R1 |
| 3 | D1 verify: GET /page.js returns 200, xterm mounts | message_clarity: 5, feedback_timing: 5, error_handling: 4, layout: 5, interactivity: 5, visual_rendering: 5 | — |
| 4 | D3 verify: task_prompt has no literal placeholders | message_clarity: 5, feedback_timing: 5, error_handling: 5, layout: 5, interactivity: 5, visual_rendering: 5 | — |
| 5 | D4 verify: host_config inherited + warning=null | message_clarity: 5, feedback_timing: 5, error_handling: 4, layout: 5, interactivity: 5, visual_rendering: 5 | — |
| 6 | Drive workflow: type /do-work via browser | message_clarity: 5, feedback_timing: 5, error_handling: 5, layout: 5, interactivity: 5, visual_rendering: 5 | — |

## Defects

### FD-R1 [LOW] Detached child changes cwd to scratchDir, breaking relative --scenario paths

- dimension: `error_handling`
- step: `start-detach`
- repro: `node packages/e2e/dist/cli.js start /tmp/scratch --scenario packages/e2e/scenarios/full-feature.json --surface web --detach  # ENOENT. Replace with absolute path: --scenario $PWD/packages/e2e/scenarios/full-feature.json  # works.`
- notes: Recommendation: either keep cwd=process.cwd() for the detached child (so relative paths resolve as the operator typed them) or normalize --scenario to an absolute path in parseStartArgs so the spawn cwd doesn't matter.

Evidence:
  - `packages/e2e/src/cli.ts:374 sets cwd: args.scratchDir for the detached spawn`
  - `Reproduced: ux-e2e start <scratch> --scenario packages/e2e/scenarios/full-feature.json --detach fails with ENOENT; same command in foreground works because foreground inherits parent cwd. Absolute --scenario path works around it.`
  - `packages/e2e/README.md line 25 example still uses a relative --scenario path.`

## Agent quality

**Rating:** 3/5  

Tested agent (omp 17.2.3) boots, accepts typed commands, renders output, handles autocomplete, and surfaces a clean 'No model selected' error box. Could not drive the workflow stages because the sandbox has no API keys for the configured opencode-go provider and no local LLM at ollama/lm-studio/llama.cpp URLs. UX of the error message is good (multi-line, explains /login + /model + API key env var + agent.db creation). The tested agent itself is not the unit under test; the framework that drove it worked correctly.

## Evidence

- `/tmp/omp-ux-e2e-ux-e2e-reference2/.work-state/ux-e2e/transcript.jsonl`
- `/tmp/omp-ux-e2e-ux-e2e-reference2/.work-state/ux-e2e/session.json`
- `/Users/a.vladislavov/projects/oss/omp-workflows-monorepo/.work-state/artifacts/ux-e2e-evidence-rerun/03-xterm-mounted-d1.png`
- `/Users/a.vladislavov/.omp/logs/omp.2026-08-02.83465.log`
