# Subagent tree nested agents — Desktop E2E scenario

Platform: Desktop through a hub-supervised live OMP PTY with the current package loaded via `--extension packages/fullstack` (directory form preserves extension and agent-definition discovery)  
Branch: `fix/subagent-tree-nested-agents`

- [x] Build the fullstack plugin and E2E harness; expected: both packages compile from the current branch.
- [x] Bootstrap a scratch project linked to the current monorepo; expected: the scratch contains links to the freshly built packages.
- [x] Launch OMP 18.0.4 in the scratch project's supervised PTY; expected: the main TUI loads and `/subagents status` is available.
- [x] Spawn one typed `team-lead` that spawns one nested worker; expected: both agents remain running concurrently. Evidence: `CanonicalLead` (`team-lead`) and `CanonicalLead.CanonicalWorker` (`task`) were simultaneously marked running.
- [x] Open the built-in Agent Hub and switch to tree mode; expected: it reports two running agents and nests the worker under `team-lead`. Evidence: `⟳ 2 running`, `⟳ CanonicalLead team-lead`, then `⟳ └── CanonicalLead.CanonicalWorker task`.
- [x] Run `/subagents expanded`; expected: the extension HUD also reports two agents and the same parent/child lineage. Evidence: the live PTY rendered `── Subagents (2) ──`, `└─ ✓ team-lead`, and its indented `└─ ✓ task` child.
- [x] Capture PTY output for both surfaces; expected: built-in Agent Hub and extension HUD counts agree. Evidence: both surfaces reported two agents in the same canonical run.
  - [x] Let the hierarchy finish without cancellation; expected: worker yields after the real command, then lead yields. Evidence: worker `sleep 45` took 45.01 seconds and yielded; lead consumed the completed result and yielded naturally after 1m06s.
