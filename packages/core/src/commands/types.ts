/**
 * Shared command context types. All commands (team, pulse, init-team, ...)
 * accept the same shape so the engine can dispatch uniformly.
 */

import type { TaskCaller } from "../engine/stage.js";

export interface CommandContext {
  args: string;
  cwd: string;
  ui: { notify: (msg: string, kind?: string) => void };
  callTask: TaskCaller;
}

export type CommandHandler = (ctx: CommandContext) => Promise<string> | string;
