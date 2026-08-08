# Session stage details E2E scenario

- [x] Serve `.work-state/features/session-state-visualization/report.html` through a local HTTP server.
- [x] Open the report with the named `playwright-cli` session and confirm the stage list is visible.
- [x] Confirm stage disclosures are collapsed at initial load and the compact card remains readable.
- [x] Expand one stage disclosure and confirm task, profile metadata, agents, and artifact summary are visible.
- [x] Follow the in-page artifact link and confirm it targets the corresponding artifact card without an external request.
- [x] Confirm graph interaction remains available after expanding details and no external network requests are made.
