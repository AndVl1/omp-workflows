# Reconstructed stage prompt preview E2E scenario

- [x] Regenerate the do-work report from the updated core/fullstack build.
- [x] Serve the generated report and open it through the named `playwright-cli` session.
- [x] Confirm stage details remain collapsed and the reconstructed prompt preview is not visible at initial load.
- [x] Expand a stage with `promptPreview` and confirm the nested summary explicitly says it is reconstructed and not the original runtime prompt.
- [x] Expand the prompt preview and confirm stage/task/agent/input/output metadata is visible with preserved line breaks and no raw artifact body.
- [x] Confirm graph interaction still works and no external requests are made.
