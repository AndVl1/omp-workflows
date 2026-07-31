/**
 * @andvl1/omp-workflows-fullstack — default omp-workflows bundle.
 *
 * This is the thin extension entry for kotlinx/spring/react/kmp/telegram-bot
 * projects. It pulls @andvl1/omp-workflows-core, registers the engine with the
 *
 * For a custom bundle (e.g. Rust, Go-only, or any non-fullstack stack),
 * write your own package that calls `registerTeamWorkflow(pi, { roles: ..., ... })`
 * with your own role mapping. Do not depend on this package.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
  registerTeamWorkflow,
  defaultFullstackRoles,
  defaultFullstackModels,
  defaultFullstackScopeMap,
  defaultFullstackFlags,
} from "@andvl1/omp-workflows-core";

export default function ompWorkflowsFullstack(pi: ExtensionAPI): void {
  registerTeamWorkflow(pi, {
    label: "omp-workflows-fullstack",
    roles: defaultFullstackRoles,
    models: defaultFullstackModels,
    scopeMap: defaultFullstackScopeMap,
    flags: defaultFullstackFlags,
  });
}
