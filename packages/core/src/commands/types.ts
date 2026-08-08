/**
 * Shared command context types. All commands (team, pulse, init-team, ...)
 * accept the same shape so the engine can dispatch uniformly.
 *
 * OMP's extension-command context does not expose a `task` tool affordance
 * (subagent dispatch lives behind the main OMP agent's `task` tool). Commands
 * here can only read `args`, `cwd`, and post UI notifications through `ui`.
 */

export interface CommandContext {
  args: string;
  cwd: string;
  /**
   * Optional OMP session identity of the invoking session. Used by /cto to
   * make active-run selection ownership-safe: a run declaring a different
   * owner session is not amended (fresh contract), while standby runs stay
   * adoptable cross-session. Absent for legacy/test callers — session-less
   * lookup keeps current amend semantics for unowned runs.
   */
  sessionId?: string;
  ui: { notify: (msg: string, kind?: string) => void };
}

export type CommandHandler = (ctx: CommandContext) => Promise<string> | string;
