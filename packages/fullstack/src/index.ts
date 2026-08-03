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

import type {
	ExtensionAPI,
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	SessionStartEvent,
} from "@oh-my-pi/pi-coding-agent";
import {
	defaultFullstackFlags,
	defaultFullstackModelRoles,
	defaultFullstackRoles,
	defaultFullstackScopeMap,
	registerTeamWorkflow,
} from "@andvl1/omp-workflows-core";
import { ensureCommandsForSession } from "./copy-commands.js";
import {
	RESEARCH_REQUEST_MARKER_END,
	RESEARCH_REQUEST_MARKER_START,
	buildResearchRequestDeveloperInstruction,
} from "./before-agent-start-marker.js";
// Auto-derived from core taxonomy; test-invariант в test/omp-model-roles.test.ts:439-446 ловит drift.
const ROLE_COUNT = defaultFullstackModelRoles.length;

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

/**
 * `before_agent_start` hook: detect the marker envelope produced by the
 * `/omp-model-roles recommendations` custom command and inject an
 * `agent`-attributed developer message so the main LLM treats the four
 * hard steps as developer-priority. The marker is opaque to OMP — see
 * `before-agent-start-marker.ts` for the contract.
 */
function beforeAgentStartMarkerHandler(
	event: BeforeAgentStartEvent,
): BeforeAgentStartEventResult | undefined {
	if (typeof event?.prompt !== "string") return undefined;
	// Marker envelope guard: both start and end markers must be present.
	// A truncated envelope (START without END) would still inject the
	// developer instruction and promise the LLM a payload it can never
	// extract, so we bail with `undefined` and let the regular prompt
	// path handle it. The end marker is exported from the marker module
	// next to the start marker.
	if (!event.prompt.includes(RESEARCH_REQUEST_MARKER_START)) return undefined;
	if (!event.prompt.includes(RESEARCH_REQUEST_MARKER_END)) return undefined;
	return {
		message: {
			customType: "omp-model-roles-research-instructions",
			content: buildResearchRequestDeveloperInstruction(ROLE_COUNT),
			display: true,
			// `details` carries the marker contract advertised to recipients
			// (custom UI, downstream tooling). It mirrors the top-level
			// fields of the in-payload `ResearchRequest` (see
			// `@andvl1/omp-workflows-core` model-roles module and
			// `buildResearchPrompt`) without re-parsing the prompt: the
			// full inventory lives inside the marker payload and is
			// duplicated here only as a count.
			details: {
				kind: "omp-model-role-research-request",
				schemaVersion: 1,
				requestedAt: new Date().toISOString(),
				roleCount: ROLE_COUNT,
				// `modelCount` is intentionally `null`: counting requires
				// parsing the embedded JSON payload, which we deliberately
				// avoid in the hook (re-parse + re-validate of a payload
				// the LLM already sees). Receivers that need the actual
				// list must read it from the payload, keeping the two
				// in sync.
				modelCount: null,
			},
			attribution: "agent",
		},
	};
}

export default function ompWorkflowsFullstack(pi: ExtensionAPI): void {
  registerTeamWorkflow(pi, {
    label: "omp-workflows-fullstack",
    roles: defaultFullstackRoles,
    scopeMap: defaultFullstackScopeMap,
    flags: defaultFullstackFlags,
  });

  // Marker detector for `/omp-model-roles recommendations` — fires before
  // each agent loop and injects a developer-attributed instruction when
  // the custom command's return value carries the marker envelope.
  pi.on("before_agent_start", beforeAgentStartMarkerHandler);

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
