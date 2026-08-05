/**
 * @andvl1/omp-workflows-core — public API surface.
 *
 * Workflow engine: 7 slash commands, 4 event handlers, 8 declarative
 * JSON profiles, typed artifact schemas, state machine, role/scope
 * resolution, DoD lifecycle, plus runtime observability (event log +
 * rollup). No agents, no skills — bundles ship those.
 *
 * Example minimal bundle:
 *
 *   import { registerTeamWorkflow, defaultFullstackRoles } from "@andvl1/omp-workflows-core";
 *   export default function (pi: ExtensionAPI) {
 *     registerTeamWorkflow(pi, {
 *       label: "omp-workflows-fullstack",
 *       roles: defaultFullstackRoles,
 *     });
 *   }
 */

import type { ExtensionAPI, BeforeAgentStartEvent, SessionStopEvent, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { classificationGate } from "./gates/classification.js";
import { monotonicGate } from "./gates/monotonic.js";
import { dodBackstop } from "./gates/dod-backstop.js";
import { safetyGuard } from "./gates/safety.js";
import { registerObservabilityHooks } from "./observability/index.js";
import type { RoleConfig } from "./engine/types.js";

export interface RegisterOptions {
  label?: string;
  roles?: RoleConfig["roles"];
  rosterOverrides?: RoleConfig["roster_overrides"];
  scopeMap?: RoleConfig["scope_map"];
  flags?: RoleConfig["flags"];
  designSystem?: string | null;
  commands?: Array<CommandId>;
  /**
   * Telemetry opt-in. Default: true (always on). Set to `false` to disable
   * the recorder for bundles that don't want per-session event logs.
   */
  observability?: boolean;
}

export type CommandId =
  | "team" | "team-next" | "team-yolo" | "pulse" | "init-team" | "interview" | "coordinator-stats";

export const defaultFullstackRoles: RoleConfig["roles"] = {
  analyst: "analyst",
  "tech-researcher": "tech-researcher",
  diagnostics: "diagnostics",
  architect: "architect",
  architect_minimal: "architect",
  architect_clean: "architect",
  architect_pragmatic: "architect",
  "backend-kotlin": "developer-kotlin",
  go: "developer-go",
  frontend: "frontend-developer",
  mobile: "developer-mobile",
  qa: "qa",
  "manual-qa": "manual-qa",
  "code-reviewer": "code-reviewer",
  "security-tester": "security-tester",
  devops: "devops",
};


export const defaultFullstackScopeMap: RoleConfig["scope_map"] = [
  { glob: ["**/iosApp/**", "**/composeApp/**", "**/commonMain/**", "**/androidMain/**"], scope: "mobile", dev_agent: "developer-mobile" },
  { glob: ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.ts", "**/src/jsMain/**", "**/miniapp/**", "**/frontend/**"], scope: "frontend", dev_agent: "frontend-developer" },
  { glob: ["**/*.go", "**/go.mod", "**/go.sum"], scope: "go", dev_agent: "developer-go" },
  { glob: ["**/Dockerfile", "**/*.yaml", "**/*.yml", "**/helm/**", "**/.github/**", "**/k8s/**"], scope: "devops", dev_agent: "devops" },
  { glob: ["**/*.kt", "**/*.java", "**/src/main/**"], scope: "backend-kotlin", dev_agent: "developer-kotlin" },
];

export const defaultFullstackFlags: RoleConfig["flags"] = {
  has_security: ["**/auth/**", "**/security/**", "**/*crypto*", "**/*Secret*", "**/*Token*"],
  has_infra: ["**/Dockerfile", "**/helm/**", "**/k8s/**", "**/.github/workflows/**"],
};
// ── Model-role taxonomy ─────────────────────────────────────────────────────
export { defaultFullstackModelRoles } from "./model-roles.js";
export {
	resolveRoleChain,
	isResearchRequest,
	isResearchResponse,
	validateResearchRequest,
	validateResearchResponse,
} from "./model-roles.js";
export type {
	ModelRoleEntry,
	InventoryModel,
	RoleLookup,
	RoleResolution,
	RoleResolutionStatus,
	ResearchRequest,
	ResearchResponse,
	BenchmarkSource,
	ResearchRecommendation,
} from "./model-roles.js";

/**
 * Wire the engine into omp's ExtensionAPI. Bundles call this from their
 * default export. The engine consults `.omp/team.config.json` (or the
 * `roles`/`scopeMap` overrides) at runtime to resolve workflow roles to agents.
 *
 * Extension-side responsibilities:
 * - Register gates (classification, monotonic, dod-backstop, safety).
 * - Write runtime config (roles, scope, flags) for custom-TS commands.
 * - Register observability hooks (event log + rollup in `.work-state/features/<slug>/observability/`).
 *
 * Slash commands are NOT registered here. Since OMP 17.x, the `task` tool
 * lives on the main agent only — `ExtensionCommandContext` exposes no
 * subagent-dispatch affordance. Workflow commands ship as OMP custom-TS
 * commands in `packages/fullstack/commands/<name>/index.ts`; they receive
 * a `HookCommandContext` that can read `cwd`, `ui`, `sessionManager`, and
 * `modelRegistry`, and rely on `ctx.sendUserMessage(prompt)` to hand the
 * profile-driven workflow to the main agent's own `task` tool.
 */
export function registerTeamWorkflow(pi: ExtensionAPI, opts: RegisterOptions = {}): void {
	const label = opts.label ?? "omp-workflows";
	pi.setLabel(label);

	writeRuntimeConfig(opts);

	// ── Gates ────────────────────────────────────────────────────────────────
	// @ts-expect-error -- ExtensionAPI.on(string, handler) overload is enough at runtime; we type the handler explicitly.
	pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx: unknown) => {
		const c = ctx as { cwd: string };
		const r1 = classificationGate(event as unknown as Parameters<typeof classificationGate>[0], c);
		if (r1?.block) return r1;
		const r2 = monotonicGate(event, c);
		if (r2?.block) return r2;
	});
	pi.on("session_stop", (event: SessionStopEvent, ctx: unknown) => {
		const c = ctx as { cwd: string };
		return dodBackstop(event as unknown as Parameters<typeof dodBackstop>[0], c);
	});

	pi.on("tool_call", (event: ToolCallEvent, ctx: unknown) => {
		const c = ctx as { cwd: string };
		return safetyGuard(event as unknown as Parameters<typeof safetyGuard>[0], c);
	});

	// ── Observability ────────────────────────────────────────────────────────
	// Wire telemetry hooks AFTER gates so a blocked agent_start still emits
	// the event (operators want to see *why* the gate fired). The recorder
	// is best-effort; never throws.
	registerObservabilityHooks(pi, { enabled: opts.observability });
}

function writeRuntimeConfig(opts: RegisterOptions): void {
  const hasOverride = opts.roles || opts.scopeMap || opts.flags || opts.rosterOverrides;
  if (!hasOverride) return;
  try {
    const { resolveRuntimeConfigPath, writeConfig } = require("./runtime-config.js") as typeof import("./runtime-config.js");
    const path = resolveRuntimeConfigPath(process.cwd());
    if (!path) return;
    writeConfig(path, {
      roles: opts.roles ?? {},
      roster_overrides: opts.rosterOverrides ?? {},
      scope_map: opts.scopeMap ?? [],
      flags: opts.flags ?? {},
      design_system: opts.designSystem ?? null,
    });
  } catch {
    // best-effort
  }
}
export { teamCommand } from "./commands/team.js";
export {
	teamNextCommand,
	teamYoloCommand,
	pulseCommand,
	initTeamCommand,
	interviewCommand,
	coordinatorStatsCommand,
} from "./commands/shortcuts.js";
export type { CommandContext } from "./commands/types.js";
export {
	loadAllProfiles,
	loadProfile,
	resolveWorkflow,
	selectProfile,
} from "./engine/profile.js";
export { resolveConfig } from "./engine/config.js";
export { resolveScope, applyConditional, shouldSkip } from "./engine/scope.js";
export {
	writeState,
	setStageStatus,
	setPause,
	checkMonotonic,
	resolveState,
} from "./engine/state.js";
export {
	writeArtifact,
	readArtifact,
} from "./engine/artifacts.js";
export {
	appendDoDItem,
	closeDoDItem,
	readDoD,
	isDoDComplete,
	isRootCauseDocumented,
} from "./engine/dod.js";
export {
	run,
	type RunOptions,
	type RunResult,
} from "./engine/run.js";
export {
	walkProfile,
	runStage,
	createTaskCaller,
	spawnLabel,
	type TaskCaller,
	type TaskResult,
	type TaskToolLike,
	type StageContext,
	type StageOutcome,
} from "./engine/stage.js";
export type {
	Profile,
	StageDef,
	StageType,
	StageStatus,
	PauseKind,
	TaskType,
	Complexity,
	Confidence,
	WorkflowName,
	Classification,
	TeamState,
	RoleConfig,
	DoD,
	DoDItem,
} from "./engine/types.js";
// ── CTO sub-orchestration (pure engine) ────────────────────────────────────
export { MAX_TEAMS, MAX_DECOMPOSITION_DEPTH } from "./cto/types.js";
export type {
	TeamDef,
	TeamPlan,
	TeamPlanEntry,
	WorktreeStrategy,
	Escalation,
	EscalationOption,
	EscalationLevel,
	EscalationAdapter,
	EscalationReceipt,
	EscalationStatus,
	EscalationRecord,
	EscalationAnswer,
	TeamRunStatus,
	CtoState,
} from "./cto/types.js";
export {
	validateEscalation,
	sanitizeEscalation,
	answersDir,
	readAnswers,
	ensureAnswersDir,
} from "./cto/escalation.js";
export { buildTeamPlan, validateDecompositionDepth, loadTeamDefs, type PlanTeamInput, type BuildResult } from "./cto/plan.js";
export {
	ctoStateDir,
	ctoStatePath,
	newCtoState,
	readCtoState,
	writeCtoState,
	setTeamStatus,
	setEscalation,
	setEscalationStatus,
	setIntegration,
	setCtoPause,
	expireEscalations,
	pendingEscalations,
	activeTeams,
} from "./cto/state.js";
export { teamDoDComplete, integrationDoD, ctoBackstop } from "./cto/gates.js";
export { runCto, ctoRunId, type RunCtoOptions, type RunCtoResult } from "./cto/run.js";
export {
  ctoCommand,
  parseEnvelope as parseCtoEnvelope,
  buildCtoPrompt,
  buildAmendPrompt,
  buildStandbyCtoPrompt,
  renderChannelSection,
  findActiveCtoRun,
  type ParsedCtoEnvelope,
} from "./commands/cto.js";
export { markAmended } from "./cto/state.js";
export {
	EventRecorder,
	rollupFromEvents,
	readObservabilityPointer,
	extractSkills,
	type ObservabilityEvent,
	type ObservabilityPointer,
	type ObservabilityRollup,
	type EventKind,
} from "./observability/index.js";

/**
 * Marker exported so custom-TS commands can detect that the engine was
 * wired in this package (i.e. the bundle is `omp-workflows-fullstack` or
 * a derivative that calls `registerTeamWorkflow`). Used by the bundled
 * commands to short-circuit when no engine is present.
 */
export const CORE_ENGINE_MARKER = "omp-workflows-core/0.8.0";
