/**
 * /cto — CTO sub-orchestration custom-TS command.
 *
 * prompt that the MAIN AGENT of the session (the resident CTO) executes
 * in-session. The implementation is re-exported from core through the
 * self-contained discovery adapter in `./_lib/cto.ts`.
 * The CTO role is main-session only: never dispatched via `task(agent=cto)`.
 */

import type { CustomCommand, CustomCommandAPI } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/types";
import type { HookCommandContext } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/types";
import { buildAmendPrompt, buildCtoPrompt, buildStandbyCtoPrompt, findActiveCtoRun, parseEnvelope } from "./_lib/cto.js";

const factory = (api: CustomCommandAPI): CustomCommand => ({
  name: "cto",
  description: "CTO sub-orchestration (main-session role): the resident CTO decomposes a task into parallel development teams. /cto <task>; /cto alone starts STANDBY (tasks arrive via messenger inbox). Runs in-session — never task(agent=cto)",
  async execute(args: string[], ctx: HookCommandContext): Promise<string> {
    const cwd = ctx.cwd ?? api.cwd;
    if (!cwd) return "ERROR: no cwd available.";
    const raw = args.join(" ").trim();
    if (!raw) {
      ctx.ui?.notify?.("cto: standby mode — awaiting tasks via messenger inbox", "info");
      return buildStandbyCtoPrompt(cwd);
    }
    // Session identity for run ownership: interactive task runs are amended
    // only by the session that owns them; foreign sessions get a fresh
    // contract. Standby runs stay adoptable cross-session.
    const sessionId = ctx.sessionManager?.getSessionId?.() ?? undefined;
    const envelope = parseEnvelope(raw, cwd);
    if (!envelope.task) return "ERROR: empty task after stripping prefix.";
    const active = findActiveCtoRun(cwd, { sessionId });
    if (active) {
      ctx.ui?.notify?.(`cto: amending run ${active.runId} with: ${envelope.task.slice(0, 50)}`, "info");
      return buildAmendPrompt(envelope, cwd, active, { sessionId });
    }
    ctx.ui?.notify?.(`cto: ${envelope.task.slice(0, 60)} (decomposition pending)`, "info");
    return buildCtoPrompt(envelope, cwd, { sessionId });
  },
});

export default factory;
