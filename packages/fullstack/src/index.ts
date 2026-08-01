/**
 * @andvl1/omp-workflows-fullstack — default omp-workflows bundle.
 *
 * Registers the workflow engine (gates + role mapping) with OMP and
 * auto-bootstraps the shipped custom-TS slash commands into the active
 * project's `.omp/commands/` directory on every session start.
 *
 * For a custom bundle (e.g. Rust, Go-only, or any non-fullstack stack),
 * write your own package that calls `registerTeamWorkflow(pi, { roles: ..., ... })`
 * with your own role mapping. Do not depend on this package.
 */

import type { ExtensionAPI, SessionStartEvent } from "@oh-my-pi/pi-coding-agent";
import {
  registerTeamWorkflow,
  defaultFullstackRoles,
  defaultFullstackScopeMap,
  defaultFullstackFlags,
} from "@andvl1/omp-workflows-core";
import { ensureCommandsForSession } from "./copy-commands.js";

/**
 * Narrow the `session_start` context to a usable cwd string. The OMP
 * extension API exposes ExtensionContext.cwd at runtime but the bundled
 * .d.ts lacks a typed overload for this hook, so we hand-narrow at the
 * boundary instead of an unchecked cast.
 */
function extractCwdFromContext(ctx: unknown): string | undefined {
	if (!ctx || typeof ctx !== "object") return undefined;
	const candidate = "cwd" in ctx ? ctx.cwd : undefined;
	return typeof candidate === "string" && candidate.length > 0 ? candidate : undefined;
}

export default function ompWorkflowsFullstack(pi: ExtensionAPI): void {
  registerTeamWorkflow(pi, {
    label: "omp-workflows-fullstack",
    roles: defaultFullstackRoles,
    scopeMap: defaultFullstackScopeMap,
    flags: defaultFullstackFlags,
  });

  // Auto-bootstrap OMP custom-TS slash commands into the active project's
  // `.omp/commands/` directory on every session start. OMP's discovery
  // (see `discoverCustomCommands` in @oh-my-pi/pi-coding-agent) only
  // reads from project-local `.omp/commands/<name>/index.ts` — it does
  // NOT scan `node_modules` of omp-managed plugins. `omp plugin install`
  // puts the package in `~/.omp/plugins/`, which never triggers npm's
  // `postinstall` hook, so without this listener the user would have to
  // run `npx omp-workflows-copy-commands` manually.
  //
  // Best-effort, never throws: any IO error is captured by
  // `ensureCommandsForSession` and dropped.
  pi.on("session_start", (_event: SessionStartEvent, ctx: unknown) => {
    const cwd = extractCwdFromContext(ctx);
    if (!cwd) return;
    ensureCommandsForSession(cwd);
  });
}
