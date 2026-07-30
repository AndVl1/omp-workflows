/**
 * @omp-workflows/core — public API surface.
 *
 * Workflow engine: 7 slash commands, 4 event handlers, 8 declarative
 * JSON profiles, typed artifact schemas, state machine, role/scope
 * resolution, DoD lifecycle. No agents, no skills — bundles ship those.
 *
 * Example minimal bundle:
 *
 *   import { registerTeamWorkflow, defaultFullstackRoles } from "@omp-workflows/core";
 *   export default function (pi: ExtensionAPI) {
 *     registerTeamWorkflow(pi, {
 *       label: "omp-workflows-fullstack",
 *       roles: defaultFullstackRoles,
 *     });
 *   }
 */

import type { ExtensionAPI, BeforeAgentStartEvent, SessionStopEvent, ToolCallEvent } from "@oh-my-pi/pi-coding-agent";
import { teamCommand } from "./commands/team.js";
import {
  teamNextCommand,
  teamYoloCommand,
  pulseCommand,
  initTeamCommand,
  interviewCommand,
  coordinatorStatsCommand,
} from "./commands/shortcuts.js";
import type { CommandContext, CommandHandler } from "./commands/types.js";
import { classificationGate } from "./gates/classification.js";
import { monotonicGate } from "./gates/monotonic.js";
import { dodBackstop } from "./gates/dod-backstop.js";
import { safetyGuard } from "./gates/safety.js";
import type { RoleConfig } from "./engine/types.js";

export interface RegisterOptions {
  label?: string;
  roles?: RoleConfig["roles"];
  models?: RoleConfig["models"];
  rosterOverrides?: RoleConfig["roster_overrides"];
  scopeMap?: RoleConfig["scope_map"];
  flags?: RoleConfig["flags"];
  designSystem?: string | null;
  commands?: Array<CommandId>;
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

export const defaultFullstackModels: RoleConfig["models"] = {
  architect: "opus",
  "code-reviewer": "opus",
  "security-tester": "opus",
  "tech-researcher": "haiku",
  "*": "sonnet",
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

/**
 * Wire the engine into omp's ExtensionAPI. Bundles call this from their
 * default export. The engine consults `.omp/team.config.json` (or the
 * `roles`/`models`/`scopeMap` overrides) at runtime to resolve role →
 * agent + model.
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
  // ── Slash commands ───────────────────────────────────────────────────────
  const enabled = new Set<CommandId>(
    opts.commands ?? ["team", "team-next", "team-yolo", "pulse", "init-team", "interview", "coordinator-stats"],
  );
  const wrap = (fn: CommandHandler) => async (args: string, ctx: unknown) => {
    const c = ctx as unknown as {
      cwd: string;
      ui: { notify: (msg: string, kind?: string) => void };
      callTask: import("./engine/stage.js").TaskCaller;
    };
    const result = await fn({ args, cwd: c.cwd, ui: c.ui, callTask: c.callTask });
    if (typeof result === "string" && result.length > 0) {
      c.ui.notify(result, "info");
    }
  };

  if (enabled.has("team")) {
    pi.registerCommand("team", {
      description: "Run a workflow via the profile-driven /team interpreter. /team <task>.",
      handler: wrap(teamCommand),
    });
  }
  if (enabled.has("team-next")) {
    pi.registerCommand("team-next", {
      description: "Run the next task from the queue.",
      handler: wrap(teamNextCommand),
    });
  }
  if (enabled.has("team-yolo")) {
    pi.registerCommand("team-yolo", {
      description: "Autonomous yolo loop: one task per tick through /team.",
      handler: wrap(teamYoloCommand),
    });
  }
  if (enabled.has("pulse")) {
    pi.registerCommand("pulse", {
      description: "Read-only project steward: digest + next-action menu.",
      handler: wrap(pulseCommand),
    });
  }
  if (enabled.has("init-team")) {
    pi.registerCommand("init-team", {
      description: "Detect stacks and emit .omp/team.config.json.",
      handler: wrap(initTeamCommand),
    });
  }
  if (enabled.has("interview")) {
    pi.registerCommand("interview", {
      description: "Deep interview to clarify ideas before implementation.",
      handler: wrap(interviewCommand),
    });
  }
  if (enabled.has("coordinator-stats")) {
    pi.registerCommand("coordinator-stats", {
      description: "Rollup profile-usage and propose new profiles.",
      handler: wrap(coordinatorStatsCommand),
    });
  }
}

function writeRuntimeConfig(opts: RegisterOptions): void {
  const hasOverride = opts.roles || opts.models || opts.scopeMap || opts.flags || opts.rosterOverrides;
  if (!hasOverride) return;
  try {
    const { resolveRuntimeConfigPath, writeConfig } = require("./runtime-config.js") as typeof import("./runtime-config.js");
    const path = resolveRuntimeConfigPath(process.cwd());
    if (!path) return;
    writeConfig(path, {
      roles: opts.roles ?? {},
      models: opts.models ?? {},
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
