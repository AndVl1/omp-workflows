/**
 * Register the fullstack workflow commands directly with OMP.
 * Extension-registered commands are the authoritative supported-host surface.
 * The standalone copier remains available only for explicitly requested
 * legacy disk-discovery compatibility. The handler sends the generated prompt
 * through `pi.sendUserMessage`; OMP routes that through the normal prompt
 * lifecycle, so `before_agent_start`, `context`, and other external extension
 * hooks still see the workflow prompt.
 *
 * Registered commands intentionally take precedence over any stale
 * project-local copies when a legacy runtime loads both. Those files are
 * compatibility artifacts, not an override API. External extensions can keep
 * augmenting the prompt through OMP hooks or register a namespaced command.
 * The core adapter owns the complete command inventory, including the native
 * `/specify`, `/spec-plan`, and `/spec-tasks` phase commands. Fullstack invokes
 * that adapter once and contributes only its existing cwd and owner lifecycle.
 *
 */

import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import {
	registerWorkflowCommands as registerCoreWorkflowCommands,
	type WorkflowCommandOptions,
} from "@andvl1/omp-workflows-core";
import { fullstackOwnerForCwd, resolveSessionCwd } from "./index.js";
import { activateCtoMode } from "./cto-mode-reminder.js";

/**
 * Fullstack is one adapter over the core command service. It supplies the
 * explicit session-cwd resolver and owner identity; parsing, command
 * precedence, direct specification phases, and CTO lifecycle remain
 * core-owned.
 */
export function registerWorkflowCommands(
	pi: ExtensionAPI,
	options: WorkflowCommandOptions = {},
): void {
	registerCoreWorkflowCommands(pi, {
		...options,
		resolveCwd: options.resolveCwd ?? resolveSessionCwd,
		owner: options.owner ?? fullstackOwnerForCwd,
		onCtoCommand: options.onCtoCommand ?? (({ cwd, sessionId, runId }) => activateCtoMode(cwd, sessionId, runId)),
	});
}
