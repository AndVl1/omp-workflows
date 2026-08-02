# UX E2E Report — ux-e2e-reference

**Verdict:** FAIL  
**Overall:** 1.0/5 — rework  
**Generated:** 2026-08-02T01:45:22.002Z

## Session

- slug: `ux-e2e-reference`
- scratch dir: `/tmp/omp-ux-e2e-ux-e2e-reference`
- omp version: `omp/17.2.3`
- profile: `ux-e2e-test`
- tty: `100x30 xterm-256color`
- started: `2026-08-02T01:41:44.133Z`
- finished: `n/a`
- scenario: `full-feature` — Full workflow: discovery -> exploration -> clarify -> architecture -> implementation -> review -> manual QA

### Task prompt

```
# Task: implement the feature described in the task prompt

Implement {{feature_description}} in the {{project_name}} project on branch feat/my-feature.

You are working in a fresh scratch project created by `ux-e2e bootstrap`. Run the
workflow exactly as you would for a real change: ask clarifying questions when the
requirements are ambiguous, and keep the change as small as reasonable.

## Requirements

- Follow the repository conventions (CLAUDE.md, team config) — this project is
  wired to the omp-workflows plugin.
- Deliver production-quality code, with tests where the conventions require them.
- The scope should cover {{platform_scope}} — clarify what is in scope if the team
  config leaves it ambiguous.
- Prefer boring, well-structured solutions over clever ones.
- Update the changelog and any docs the conventions require.

## Out of scope (unless clarified otherwise)

- Anything beyond {{platform_scope}}.
- Infrastructure changes not required by the feature.

## Notes

- The session time budget is 30m; use it wisely.
- If a requirement is underspecified (e.g. which platforms, how deep the scope),
  ask the user before proceeding — do not guess silently.

```

## Overall

**Score:** 1.0/5  
**Recommendation:** rework

The ux-e2e framework starts (bootstrap, start, and report) and the WS+PTY plumbing does carry bytes end-to-end (verified with a manual ws driver), but the web surface is broken in this build (/page.js returns 404 — page.js handler missing from server.ts). The reference run could not exercise any of the 10 stages because the framework has no way to inject LLM credentials and the omp binary reports 'No model selected'. 1 of the 6 subcommands was not usable (start --detach surfaced no child pid within 15s); only foreground mode drove the session manually.

## Regressions

- Browser surface non-functional: GET /page.js returns 404 (server.ts:981-997 only handles /, /xterm.js, /xterm.css, /addon-fit.js)
- Detached mode: `ux-e2e start --detach` printed 'timed out waiting for the detached session to start' twice in a row; caused by detached child with stdio: 'ignore' dying before session.json appears — independent of page.js bug but worth filing

## Steps

| # | Step | Rating | Defects |
|---|------|--------|---------|
| 0 | Bootstrap + start | message_clarity: 1, feedback_timing: 1, error_handling: 1, layout: 1, interactivity: 1, visual_rendering: 1 | D1 |
| 1 | Discovery (omp /do-work prompt) | message_clarity: 2, feedback_timing: 2, error_handling: 2, layout: 1, interactivity: 1, visual_rendering: 1 | D2, D3 |
| 3 | Clarify / [ask_user] | message_clarity: 1, feedback_timing: 1, error_handling: 1, layout: 1, interactivity: 1, visual_rendering: 1 | D3 |
| 99 | Report + report.json | message_clarity: 4, feedback_timing: 4, error_handling: 4, layout: 3, interactivity: 1, visual_rendering: 1 | — |

## Defects

### D1 [CRITICAL] /page.js route is missing (404)

- dimension: `error_handling`
- step: `boot`

Evidence:
  - `curl -I http://127.0.0.1:8421/page.js -> HTTP/1.1 404 Not Found`
  - `browser console (performance.getEntriesByType('resource')) shows status=404 for page.js`
  - `README + assets/terminal.html both serve /page.js; server.ts has no handler for it (only /, /xterm.js, /xterm.css, /addon-fit.js)`
  - `Impact: browser surface cannot render the xterm terminal at all; page stays on 'connecting…' forever; the framework's headline web-surface workflow is unusable`

### D2 [HIGH] Scenario placeholders ({{feature_description}}, {{platform_scope}}, ...) are not declared in scenarios/full-feature.json so they survive as literal '{{...}}' tokens in the task prompt sent to omp

- dimension: `interactivity`
- step: `stage_discovery`

Evidence:
  - `session.json task_prompt contains literal '{{feature_description}}', '{{project_name}}', '{{platform_scope}}', '{{max_time}}'`
  - `scenario.expandTemplate keeps unknown keys literal by design ('unknown keys stay literal' comment in scenario.ts:236)`
  - `Either declare them in scenario.json or strip them from full-feature-task.md before delivery`

### D3 [HIGH] omp in the scratch session reports 'Error: No model selected' and /do-work cannot fire — environment blocker (no API keys / model registered)

- dimension: `message_clarity`
- step: `stage_discovery`

Evidence:
  - `Transcript from PTY: 'Error: No model selected. Use /login, set an API key environment variable, or create /Users/a.vladislavov/.omp/profiles/ux-e2e-test/agent/agent.db. Then use /model to select a model.'`
  - `omp profile log: 'model discovery failed for provider' for ollama/lm-studio/llama.cpp`
  - `printenv shows no OPENAI/ANTHROPIC/GEMINI key; ~/.omp/profiles/ux-e2e-test/agent/models.db is empty`
  - `Impact: full 10-stage reference scenario cannot complete without operator-supplied model credentials. Framework itself is fine; the tested agent (omp) cannot proceed`

## Agent quality

**Rating:** 1/5  

omp subprocess booted, drew the welcome screen, and reached the input prompt — but never received a model so the /do-work workflow could not execute. Cannot rate the agent beyond its UI affordances because the orchestrator (the tested agent's host) can't fire.

- task_fidelity: 1

## Evidence

- `/tmp/omp-ux-e2e-ux-e2e-reference/.work-state/ux-e2e/transcript.jsonl`
- `/tmp/omp-ux-e2e-ux-e2e-reference/.work-state/ux-e2e/session.json`
- `/Users/a.vladislavov/projects/oss/omp-workflows-monorepo/.work-state/artifacts/ux-e2e-evidence/01-boot.webp`
- `/Users/a.vladislavov/projects/oss/omp-workflows-monorepo/.work-state/artifacts/ux-e2e-evidence/02-boot-after-12s.webp`
- `/Users/a.vladislavov/.omp/logs/omp.2026-08-02.83465.log`
