/**
 * /cto — CTO sub-orchestration custom-TS command.
 *
 * Same pattern as `/do-work`: parses the envelope, returns a fully-formed
 * prompt that the main agent executes through its own `task` tool. The logic
 * lives in `./_lib/cto.ts` (self-contained copy of the core contract —
 * `packages/core/src/commands/cto.ts`); canonical source is core.
 */

import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import { buildAmendPrompt, buildCtoPrompt, findActiveCtoRun, parseEnvelope } from "./_lib/cto.js";

const factory = (api: CustomCommandAPI): CustomCommand => ({
  name: "cto",
  description: "CTO sub-orchestration: decompose a task into parallel development teams. /cto <task>",
  async execute(args: string[], ctx: HookCommandContext): Promise<string> {
    const raw = args.join(" ").trim();
    if (!raw) {
      return [
        "Usage: /cto <task description> [issue=#N] [AUTONOMOUS]",
        "",
        "CTO sub-orchestration: decompose -> architecture -> teams -> integration.",
        "A second /cto while a run is active folds the new task into that run (amend).",
        "Example: /cto Add OAuth with Google and GitHub",
      ].join("\n");
    }
    const cwd = ctx.cwd ?? api.cwd;
    if (!cwd) return "ERROR: no cwd available.";
    const envelope = parseEnvelope(raw, cwd);
    if (!envelope.task) return "ERROR: empty task after stripping prefix.";
    const active = findActiveCtoRun(cwd);
    if (active) {
      ctx.ui?.notify?.(`cto: amending run ${active.runId} with: ${envelope.task.slice(0, 50)}`, "info");
      return buildAmendPrompt(envelope, active);
    }
    ctx.ui?.notify?.(`cto: ${envelope.task.slice(0, 60)} (decomposition pending)`, "info");
    return buildCtoPrompt(envelope, cwd);
  },
});

export default factory;
