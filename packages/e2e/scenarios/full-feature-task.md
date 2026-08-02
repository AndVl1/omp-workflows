# Task: {{task}}

Implement {{feature_description}} in the {{project_name}} project on branch {{branch}}.

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

- The session time budget is {{max_time}}; use it wisely.
- If a requirement is underspecified (e.g. which platforms, how deep the scope),
  ask the user before proceeding — do not guess silently.
