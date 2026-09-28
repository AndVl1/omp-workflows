# Task: {{task}}

You are working in the prepared workspace recorded by the run manifest. The
runtime and omp-workflows plugin snapshot are fixed at `prepare` time; do not
run bootstrap, npm link, or mutate a global installation. The plugin ships 17
agents whose frontmatter declares per-class OMP model roles with standard-role
fallback, and a `/omp-model-roles` command.

## Requirements

- Use the `/do-work` workflow for your change. Keep it small: add a short
  "Scratch demo" section to README.md with one code block.
- Before starting, the tester will have configured `modelRoles` in
  `.omp/config.yml` (project level). If `/omp-model-roles` is available, run
  `/omp-model-roles validate` once and report the role resolution table in your
  final summary.
- Follow the repository conventions; do not modify the plugin package itself.
- Deliver production-quality output, update the changelog if the conventions
  require it.

## Notes

- The session time budget is {{max_time}}; use it wisely.
- If a requirement is underspecified, ask the user before proceeding.
