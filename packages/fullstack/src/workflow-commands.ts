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
import {
	registerWorkflowCommands as registerCoreWorkflowCommands,
	type WorkflowCommandOptions,
} from "@andvl1/omp-workflows-core";
import { fullstackOwnerForCwd, resolveSessionCwd } from "./index.js";

/**
 * Fullstack is an adapter over the core command service. It supplies the
 * explicit session-cwd resolver and owner identity; prompt parsing and CTO
 * command lifecycle remain core-owned.
 */
export function registerWorkflowCommands(
	pi: ExtensionAPI,
	options: Omit<WorkflowCommandOptions, "owner" | "resolveCwd"> = {},
): void {
	registerCoreWorkflowCommands(pi, {
		...options,
		resolveCwd: resolveSessionCwd,
		owner: fullstackOwnerForCwd,
	});
}
