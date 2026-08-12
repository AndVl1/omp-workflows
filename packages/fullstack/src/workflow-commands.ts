/**
 * Register the fullstack workflow commands directly with OMP.
 *
 * Project-local `.omp/commands` copies remain a compatibility path for
 * runtimes that only discover custom-TS commands from disk. The handler sends
 * the generated prompt through `pi.sendUserMessage`; OMP routes that through
 * the normal prompt lifecycle, so `before_agent_start`, `context`, and other
 * external extension hooks still see the workflow prompt.
 *
 * Registered commands intentionally take precedence over same-name
 * project-local copies. Those files are generated compatibility artifacts,
 * not an override API. External extensions can keep augmenting the prompt
 * through OMP hooks or register a namespaced/direct extension command.
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import { registerWorkflowCommands as registerCoreWorkflowCommands } from "@andvl1/omp-workflows-core";

// Kept as the fullstack export boundary for existing consumers and tests.

/**
 * Register the authoritative `/do-work`, `/team`, and `/cto` surfaces.
 * Registration happens while the extension is loaded, before OMP snapshots
 * slash suggestions and before project-local custom command files are read.
 * Same-name external extension commands still follow OMP's normal extension
 * load-order rule; Claude marketplace commands remain namespaced.
 */
export function registerWorkflowCommands(pi: ExtensionAPI): void {
	registerCoreWorkflowCommands(pi);
}
