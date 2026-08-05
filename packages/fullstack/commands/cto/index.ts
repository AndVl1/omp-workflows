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
import { buildAmendPrompt, buildCtoPrompt, buildStandbyCtoPrompt, findActiveCtoRun, parseEnvelope } from "./_lib/cto.js";

const factory = (api: CustomCommandAPI): CustomCommand => ({
  name: "cto",
  description: "CTO sub-orchestration: decompose a task into parallel development teams. /cto <task>; /cto alone starts STANDBY (tasks arrive via messenger inbox)",
  async execute(args: string[], ctx: HookCommandContext): Promise<string> {
    const cwd = ctx.cwd ?? api.cwd;
    if (!cwd) return "ERROR: no cwd available.";
    const raw = args.join(" ").trim();
    if (!raw) {
      ctx.ui?.notify?.("cto: standby mode — awaiting tasks via messenger inbox", "info");
      return buildStandbyCtoPrompt(cwd);
    }
    const envelope = parseEnvelope(raw, cwd);
    if (!envelope.task) return "ERROR: empty task after stripping prefix.";
    const active = findActiveCtoRun(cwd);
    if (active) {
      ctx.ui?.notify?.(`cto: amending run ${active.runId} with: ${envelope.task.slice(0, 50)}`, "info");
      return buildAmendPrompt(envelope, cwd, active);
    }
    ctx.ui?.notify?.(`cto: ${envelope.task.slice(0, 60)} (decomposition pending)`, "info");
    return buildCtoPrompt(envelope, cwd);
  },
});

export default factory;
