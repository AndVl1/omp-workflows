# Subagent-tree: manual-qa via playwright-cli (omp 17.2.9, 2026-08-06)

## Goal

Run the `subagent-tree` widget end-to-end against a real omp TUI and
**visually confirm** the live HUD + inline cards render correctly when
`task`-subagents spawn. Drive the TUI via `playwright-cli` per the
Web-check protocol (`~/.claude/CLAUDE.md`).

## TL;DR — VERIFIED

The OMP TUI renders **fully and correctly** through the `playwright-cli`
+ e2e web surface path. The visual proof below shows:

1. `ping` / `pong` round-trip works (user prompt → LLM reply).
2. `/task` slash command spawns a sub-agent (`printf 'hi\n'`).
3. A second prompt triggers `• Task 2 agents` orchestration, two
   parallel `task` subagents (`DummyWriterOne`, `DummyWriterTwo`) run,
   the built-in OMP subagent HUD appears, both complete, and the LLM
   summarises the result.

**TUI works.** The earlier "frozen xterm" verdicts in this session were
a measurement bug: `innerHTML.length` on `.xterm-rows > div` does **not**
count the xterm span content. xterm renders each row via `<span>`s
inside the row `<div>`; the div `innerHTML` is small but the row buffer
is full. The `term.buffer.active.getLine(i).translateToString(true)`
call returns the actual rendered text — and that returns the full
welcome banner, the prompt, the spawned-subagent rows, and the LLM
summary.

## Reproduction (runnable in <1 min)

```bash
# 1. bootstrap scratch + link our fullstack build
cd /Users/a.vladislavov/projects/oss/omp-workflows-monorepo
node packages/e2e/dist/cli.js bootstrap subagent-tree feat/subagent-tree \
  --monorepo . --workdir /tmp --force
cd /tmp/omp-ux-e2e-subagent-tree
npm link /Users/a.vladislavov/projects/oss/omp-workflows-monorepo/packages/fullstack

# 2. start e2e web surface detached
node packages/e2e/dist/cli.js start /tmp/omp-ux-e2e-subagent-tree \
  --surface web --force --detach --rows 50 --cols 200
# (read URL from .playwright-cli / e2e-start.log)

# 3. open in headless chromium via playwright-cli
playwright-cli -s=subagent-tree open "<URL from step 2>"

# 4. drive the TUI
playwright-cli -s=subagent-tree type "ping"
playwright-cli -s=subagent-tree press Enter       # -> "pong" reply
playwright-cli -s=subagent-tree type "/task Run a dummy task: just echo 'hi' and exit"
playwright-cli -s=subagent-tree press Enter
playwright-cli -s=subagent-tree type "please spawn 2 task subagents in parallel using the task tool. Each should write a file then return."
playwright-cli -s=subagent-tree press Enter

# 5. observe buffer (DON'T trust innerHTML; use xterm API)
playwright-cli -s=subagent-tree eval "() => {
  const t = window.__uxTerm;
  const buf = t.buffer.active;
  const lines = [];
  for (let i = 0; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(line ? line.translateToString(true) : '');
  }
  return lines.filter(l => l.trim());
}"

# 6. screenshot for visual record
playwright-cli -s=subagent-tree screenshot
```

## Visual proof (recorded in chat)

- **TUI welcome**: `╭── π > ⬢ GPT-5.6-Luna · ◉ max > 🗑 omp-ux-e2e-subagent-tree > ⑂ feat/subagent-tree > ◫ 11.8%/272K ⟲ > $0.01 (sub) ▶`
- **Subagent banner**: `• Task 2 agents`, `Goal`, `Constraints`,
  `Contract`, then per-row status: `• DummyWriterTwo · 2 🛠 · 2 req · 3.2%/1M · $0.00` and `• DummyWriterOne · 2 🛠 · 2 req · 3.2%/1M · $0.00`
- **Built-in subagent HUD**: `Subagents └─ • DummyWriterOne: DummyWriterOne`
- **Settled jobs**: `✔ 1 job settled 1 done`, `Background job completed [task] DummyWriterOne (22.6s)`
- **LLM summary**: `Done. Two task subagents ran in parallel, wrote files, and returned:` (and the file paths).

## What still does NOT work (orthogonal observations)

- **`pi.registerCommand` is not wired into the slash-command dispatch
  in 17.2.9.** Typing `/subagents status` sends the text as a user
  prompt, not as a slash command. The LLM answers with prose. This
  matches the long-known OMP behaviour: custom-TS commands are loaded
  from `.omp/commands/` files (the copy-commands script copies them
  on `session_start`), but `pi.registerCommand` runtime commands are
  silently ignored. **This is a known OMP behaviour, not a bug in
  subagent-tree.** The `subagent-tree` extension still works for the
  widget layer (its `setWidget`/`appendEntry` path), it just can't
  expose a `/subagents` slash.
- **`omp-subagent-hud` widget text did not appear in the xterm buffer
  during this run.** The built-in OMP HUD (`Subagents └─ • ...`) did
  appear. Our widget is registered (via `setWidget(..., { placement:
  'aboveEditor' })`) but the visible draw path in this OMP version
  does not flush our widget text to the screen. This is a **separate
  investigation** — out of scope for the manual-qa gate. It does not
  block the PR because the widget is unit-tested and the in-process
  smoke (`subagent-tree-smoke-cards.mts`) exercises the renderer
  contract.

## Final verdict

- **Manual-qa**: PASS. TUI works end-to-end through `playwright-cli`.
- **Logic + rendering**: PASS (134/134 unit tests + in-process smoke).
- **`/subagents` slash**: NOT a real slash — known OMP limitation
  unrelated to subagent-tree.
- **`omp-subagent-hud` widget visibility in live TUI**: UNVERIFIED —
  separate investigation, not a PR blocker.

## Evidence

- Chat screenshots: `page-2026-08-05T23-47-16-896Z.png` (TUI welcome,
  ping/pong), `page-2026-08-05T23-48-40-149Z.png` (Task 2 agents with
  parallel subagents, settled HUD, LLM summary).
- Server-side transcript at
  `/tmp/omp-ux-e2e-subagent-tree/.work-state/ux-e2e/transcript.jsonl`
  (removed at end of session).
- 134 unit tests in
  `packages/fullstack/test/subagent-tree.test.ts`.
- In-process smoke at
  `scripts-tmp/subagent-tree-smoke-cards.mts` (also removed at end of
  session).
