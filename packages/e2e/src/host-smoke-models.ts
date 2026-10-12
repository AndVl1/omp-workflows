import { spawnSync } from 'node:child_process';

export interface CandidateModelPattern {
  readonly selector: string;
  readonly role: string | null;
}
export interface CandidateAgentModels {
  readonly name: string;
  readonly patterns: readonly CandidateModelPattern[];
}
export interface CandidateModelInventory {
  readonly builtinRoleIds: readonly string[];
  readonly agents: readonly CandidateAgentModels[];
}
export interface HostModelConfig {
  readonly modelRoles: Readonly<Record<string, string>>;
}
export interface HostModelPlan {
  readonly model: string;
  readonly roles: readonly string[];
  readonly config: HostModelConfig;
}
export interface CandidateModelInspectionOptions {
  readonly candidatePrefix: string;
  readonly scratchDir: string;
  readonly home: string;
  readonly agentDir: string;
  readonly extensionPath: string;
}
export interface PreparedModelConfigOptions extends CandidateModelInspectionOptions {
  readonly configPath: string;
  readonly selectedModel: string;
  readonly roles: readonly string[];
}
export interface PreparedModelConfigSmokeResult {
  readonly agentCount: number;
  readonly roles: readonly string[];
}

/** Provider/model, optionally with SDK thinking or upstream modifiers; never an alias/fallback list. */
export function requireConcreteModelSelector(selector: string): string {
  const slash = selector.indexOf('/');
  if (!selector || selector !== selector.trim() || /\s/u.test(selector) || /[*?\[]/u.test(selector) || selector.includes(',') ||
      selector === '*' || selector.startsWith('@') || selector.startsWith('pi/') ||
      selector.includes('//') || slash <= 0 || slash === selector.length - 1) {
    throw new Error('host-smoke: --model must be a concrete provider/model selector, not a role alias or fallback list');
  }
  return selector;
}

/** Every built-in and every SDK-parsed candidate role maps to the selected model. */
export function buildHostModelPlan(
  model: string,
  builtinRoleIds: readonly string[],
  agents: readonly CandidateAgentModels[],
): HostModelPlan {
  const roles = new Set<string>(['default', ...builtinRoleIds]);
  for (const agent of agents) {
    for (const pattern of agent.patterns) {
      if (pattern.role !== null) {
        if (!pattern.role) throw new Error(`host-smoke: agent ${agent.name} has an empty model role`);
        roles.add(pattern.role);
      } else if (requireConcreteModelSelector(pattern.selector) !== model) {
        throw new Error(`host-smoke: agent ${agent.name} pins a different concrete model; role-only config cannot override it`);
      }
    }
  }
  const roleIds = [...roles];
  const config: HostModelConfig = {
    modelRoles: Object.fromEntries(roleIds.map(role => [role, model])),
  };
  return { model, roles: roleIds, config };
}

const INSPECTOR = String.raw`
import { join } from 'node:path';
import { Settings } from '@oh-my-pi/pi-coding-agent/config/settings';
import { MODEL_ROLE_IDS, getKnownRoleIds } from '@oh-my-pi/pi-coding-agent/config/model-roles';
import { normalizeModelPatternList, resolveAgentModelSelection, resolveExplicitModelRole } from '@oh-my-pi/pi-coding-agent/config/model-resolver';
import { injectOmpExtensionCliRoots } from '@oh-my-pi/pi-coding-agent/discovery/omp-extension-roots';
import { discoverAgents } from '@oh-my-pi/pi-coding-agent/task/discovery';
const marker = '__HOST_SMOKE_MODEL_RESULT__';
const required = name => { const value = process.env[name]; if (!value) throw new Error('missing ' + name); return value; };
const roleLookup = { getModelRole: role => role };
const describe = agents => agents.map(agent => ({ name: agent.name, patterns: normalizeModelPatternList(agent.model).map(selector => ({ selector, role: resolveExplicitModelRole(selector, roleLookup) ?? null })) }));
const assertModel = (label, patterns, model) => { if (!patterns.length || patterns.some(value => value !== model)) throw new Error(label + ' did not resolve to selected model'); };
async function main() {
 const mode = required('HOST_SMOKE_MODE'), cwd = required('HOST_SMOKE_SCRATCH'), home = required('HOME');
 injectOmpExtensionCliRoots([required('HOST_SMOKE_EXTENSION')], home, cwd, { mode: 'merge', replace: true });
 const { agents } = await discoverAgents(cwd, home), described = describe(agents);
 const emit = value => process.stdout.write(marker + JSON.stringify(value) + '\n');
 if (mode === 'inventory') { emit({ builtinRoleIds: MODEL_ROLE_IDS, agents: described }); return; }
 if (mode !== 'verify') throw new Error('unknown inspection mode');
 const model = required('HOST_SMOKE_SELECTED_MODEL'), roles = JSON.parse(required('HOST_SMOKE_ROLES'));
 const settings = await Settings.loadReadOnly({ cwd, agentDir: required('PI_CODING_AGENT_DIR'), configFiles: [required('HOST_SMOKE_CONFIG'), join(cwd, '.omp', 'ux-e2e-overlay.json')] });
 const discovered = new Set(MODEL_ROLE_IDS);
 for (const agent of described) for (const pattern of agent.patterns) if (pattern.role !== null) discovered.add(pattern.role);
 const expected = new Set(roles);
 if ([...discovered].some(role => !expected.has(role)) || [...expected].some(role => !discovered.has(role))) throw new Error('candidate model-role inventory changed');
 const known = new Set(getKnownRoleIds(settings));
 for (const role of roles) {
  if (!known.has(role) || settings.getModelRole(role) !== model) throw new Error('model role ' + role + ' is not configured to selected model');
  assertModel('model role ' + role, resolveAgentModelSelection({ agentModel: '@' + role, settings }).patterns, model);
 }
 for (const agent of agents) {
  const selection = resolveAgentModelSelection({ agentModel: agent.model, settings });
  assertModel('candidate agent ' + agent.name, selection.patterns, model);
 }
 emit({ agentCount: agents.length, roles });
}
main().catch(error => { process.stderr.write('config-only model inspection failed: ' + (error instanceof Error ? error.message : String(error)) + '\n'); process.exitCode = 1; });
`;

function invokeInspector(
  mode: 'inventory' | 'verify', options: CandidateModelInspectionOptions, env: NodeJS.ProcessEnv,
  verification?: Pick<PreparedModelConfigOptions, 'configPath' | 'selectedModel' | 'roles'>,
): unknown {
  const childEnv: NodeJS.ProcessEnv = {
    PATH: env.PATH ?? process.env.PATH, LANG: env.LANG ?? 'C', CI: '1', NO_COLOR: '1',
    HOME: options.home, PI_CODING_AGENT_DIR: options.agentDir, PI_CONFIG_DIR: '.omp',
    OMP_PROJECT_DIR: options.scratchDir, HOST_SMOKE_MODE: mode, HOST_SMOKE_SCRATCH: options.scratchDir,
    HOST_SMOKE_EXTENSION: options.extensionPath,
  };
  for (const key of ['TMPDIR', 'TMP', 'TEMP', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'OMP_HOME'] as const) {
    if (env[key] !== undefined) childEnv[key] = env[key];
  }
  if (verification) {
    childEnv.HOST_SMOKE_CONFIG = verification.configPath;
    childEnv.HOST_SMOKE_SELECTED_MODEL = verification.selectedModel;
    childEnv.HOST_SMOKE_ROLES = JSON.stringify(verification.roles);
  }
  const result = spawnSync('bun', ['-e', INSPECTOR], { cwd: options.candidatePrefix, env: childEnv, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
  if (result.error !== undefined || result.status !== 0) throw new Error('host-smoke: candidate SDK ' + mode + ' failed: ' + String(result.stderr ?? result.error?.message ?? 'unknown error').trim());
  const line = String(result.stdout ?? '').split(/\r?\n/u).find(value => value.startsWith('__HOST_SMOKE_MODEL_RESULT__'));
  if (!line) throw new Error('host-smoke: candidate SDK ' + mode + ' returned no result');
  return JSON.parse(line.slice('__HOST_SMOKE_MODEL_RESULT__'.length)) as unknown;
}

/** Uses the installed candidate SDK discovery and public model parser, not repository agent inventory. */
export function inspectCandidateModelInventory(options: CandidateModelInspectionOptions, env: NodeJS.ProcessEnv): CandidateModelInventory {
  const value = invokeInspector('inventory', options, env) as CandidateModelInventory | null;
  if (value === null || typeof value !== 'object' || !Array.isArray(value.builtinRoleIds) || !value.builtinRoleIds.every(role => typeof role === 'string') || !Array.isArray(value.agents)) throw new Error('host-smoke: candidate SDK returned invalid model inventory');
  const agents = value.agents;
  if (agents.length === 0 || agents.some(agent => typeof agent.name !== 'string' || !Array.isArray(agent.patterns) || agent.patterns.some((pattern: CandidateModelPattern) => typeof pattern.selector !== 'string' || (pattern.role !== null && typeof pattern.role !== 'string')))) throw new Error('host-smoke: candidate SDK returned invalid agent models');
  return { builtinRoleIds: value.builtinRoleIds, agents };
}

/** Config-only proof through Settings.loadReadOnly, for one prepared scratch project. */
export function verifyPreparedModelConfig(options: PreparedModelConfigOptions, env: NodeJS.ProcessEnv): PreparedModelConfigSmokeResult {
  const value = invokeInspector('verify', options, env, options) as PreparedModelConfigSmokeResult | null;
  if (value === null || typeof value !== 'object' || typeof value.agentCount !== 'number' || !Array.isArray(value.roles) || !value.roles.every(role => typeof role === 'string')) throw new Error('host-smoke: candidate SDK returned invalid config-only result');
  return { agentCount: value.agentCount, roles: value.roles };
}
