# OMP + agent-browser AI command E2E

This guide is the execution contract for the CI AI command matrix. It is intentionally explicit: the test must exercise a real OMP interactive PTY and a real browser keyboard path. A text WebSocket submission, direct command injection, or a DOM-only assertion is not equivalent.

## Runtime and configuration

1. Build the workspace with Node.js 24, Bun 1.3.14+, and the pinned OMP package.
2. Install the pinned `agent-browser` CLI and its Chromium runtime; CI verifies both the npm tarball integrity and the Ubuntu native binary SHA-256 before use. Never resolve `latest` in CI.
3. Start each command in a fresh scratch project through `packages/e2e` (`bootstrap` then `start --surface web`). Keep the session foreground-owned by the runner; do not use `pkill`, `killall`, or an unvalidated PID.
4. The CI job exposes these public values (resolved contract):

   ```text
   OMP_API_PROVIDER=opencode-go
   OMP_BASE_MODEL=deepseek-v4-flash
   OMP_VISUAL_MODEL=minimax-m3
   ```

   `OMP_API_PROVIDER` / `OMP_BASE_MODEL` / `OMP_VISUAL_MODEL` are
   **runner-internal overrides** — the runner reads them from its own
   environment and rejects values outside the verified contract. OMP itself
   does not read these names; the model contract reaches the spawned omp
   exclusively through the `--config` modelRoles overlay
   (`node_modules/@oh-my-pi/pi-coding-agent/src/commands/launch.ts:82-85`,
   `src/config/settings.ts:381-383,1254-1286`), which the e2e server emits
   for `<scratch>/.omp/ux-e2e-overlay.user.json`
   (`packages/e2e/src/server.ts:1147-1172`).

   The provider id is `opencode-go` (not `opencode`), whose catalog descriptor
   declares the `OPENCODE_API_KEY` env var
   (`node_modules/@oh-my-pi/pi-catalog/src/provider-models/descriptors.ts:329-332`).
   The runner maps the public values to a secret-free project overlay:

   ```json
   {
     "modelRoles": {
       "default": "opencode-go/deepseek-v4-flash:high",
       "smol": "opencode-go/deepseek-v4-flash:high",
       "slow": "opencode-go/deepseek-v4-flash:high",
       "plan": "opencode-go/deepseek-v4-flash:high",
       "designer": "opencode-go/deepseek-v4-flash:high",
       "commit": "opencode-go/deepseek-v4-flash:high",
       "tiny": "opencode-go/deepseek-v4-flash:high",
       "task": "opencode-go/deepseek-v4-flash:high",
       "advisor": "opencode-go/deepseek-v4-flash:high",
       "vision": "opencode-go/minimax-m3"
     }
   }
   ```

   Evidence notes (pi-catalog is the source of truth):
   - `opencode-go/deepseek-v4-flash` is a valid openai-completions model,
     input `["text"]`
     (`node_modules/@oh-my-pi/pi-catalog/src/models.json:66502-66511`).
   - `opencode-go/minimax-m2.5` **exists but is TEXT ONLY** (input
     `["text"]`, anthropic-messages — `models.json:66960-66969`), so it
     can never serve `modelRoles.vision`; the runner rejects it with this
     evidence in the error. It is not silently accepted or substituted.
   - `opencode-go/minimax-m3` is the vision-capable MiniMax model on
     opencode-go (input `["text","image"]` —
     `models.json:67021-67031`); other vision-capable ids: `kimi-k2.5`
     (`models.json:66712-66722`), `mimo-v2.5`
     (`models.json:66899-66909`).

   `OPENCODE_API_KEY` is inherited by the PTY only from the trusted CI secret. It must never be written into the overlay, prompt, report, screenshot metadata, or command line.

## Visual command protocol

For every command listed in `ai-command-manifest.json`, the runner uses the same bounded prompt template and only varies the command's safe `instruction` plus short `command_args`. The prompt explicitly forbids edits, delegation, production access, and waiting for full workflow completion.

1. Write the session token to a mode-600 curl-style cookie file and import it with `agent-browser cookies set --curl ... --domain 127.0.0.1 --path / --httpOnly --sameSite Lax`. Open the bearer-free origin with a unique agent-browser session name (`agent-browser --session <unique> open <origin>`). The runner never puts the token in the browser process command line; `/session-token.js` is intentionally unavailable. Use `--session`, not the legacy `--session-name` restore-key alias, so each command owns an isolated browser context.
2. Focus the terminal and use `agent-browser keyboard type` to send `/` and the manifest's short picker prefix as real keyboard events. Type slowly enough to stay below the e2e server's inbound rate limit.
3. Poll the xterm internal buffer. The reliable screen expression is:

   ```js
   (() => {
     const term = window.__uxTerm;
     if (!term) return "";
     const lines = [];
     const count = term.rows ?? term.buffer.active.length;
     for (let i = 0; i < count; i += 1) {
       lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "");
     }
     return lines.join("\n");
   })()
   ```

   Assert that the picker contains the expected command and a selected-candidate marker (`❯`). Do not use `.xterm-rows div.innerHTML`; xterm renders command text inside nested spans, so that measurement can be empty while the terminal is correct.
4. Send `agent-browser press Tab`. Poll the same xterm buffer and assert that the editor now contains the exact full command (`/cto`, `/do-work`, and so on), not only the partial prefix.
5. Append the short command-specific task from the manifest with `keyboard type`. The task must be safe, bounded, and local. It must not ask the model to edit files, call production, delegate work, or wait for a complete workflow.
6. Submit with `agent-browser press Enter`. This is a real keyboard event and reaches the PTY as carriage return (`\r`). Do not use LF, `input`, `submit`, `keyboard inserttext`, or a raw WebSocket frame as a substitute.
7. Poll for a command-specific start signal that is newly emitted after Enter; a pattern already present in the submitted task does not count. Accept the command notification, deterministic report/role output, or a fresh `Working`/`Thinking` transition. Reject provider/authentication/rate-limit/picker/process errors. A pass proves that the selected command entered its real execution path; it does not wait for the full production workflow.

## Timeouts and teardown

Each phase is bounded: bootstrap/materialization, OMP startup, browser open, picker, Tab selection, task submission, start observation, and teardown. A slow provider is a failure with a command and phase, not a reason to run indefinitely. The matrix runs commands sequentially with a new scratch, PTY, isolated OMP environment/profile inputs, and browser session each time so command discovery/import caches and state cannot bleed between cases.

Always close the agent-browser session first, then close the bounded `TestSession`. Cleanup runs after picker failures, provider failures, assertion failures, timeout failures, and successful start evidence. Continue collecting remaining cases after one case fails, then exit non-zero with the complete sanitized report.

## Evidence and security

Keep only bounded, redacted screen snapshots, phase results, command ids, and sanitized diagnostics. Replace the API key, bearer/token values, session URL query, scratch paths, and repository absolute paths before staging. Scan every staged byte for the exact secret and key-shaped values; if the scan fails, do not upload artifacts.

The secret-bearing ai-e2e job intentionally runs on `pull_request_target`, but only under a guarded contract: same-repository PRs targeting `main`, a same-repo-only guard, the protected `ai-e2e` environment, and the trusted-base workflow — the job definition and env wiring come from the base branch's `ci.yml`, and the PR head is checked out only for the runner code. Ordinary `pull_request` events and fork PRs never receive the key: fork PRs skip the secret-bearing job entirely.
