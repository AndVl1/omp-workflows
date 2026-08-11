import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseBootstrapArgs,
  runBootstrap,
  type BootstrapArgs,
} from './cli.js';
import {
  startTestSession,
  type TestSession,
  type TestSessionOptions,
} from './server.js';
import { deferred } from './util.js';


const execFileAsync = promisify(execFile);

/**
 * Resolved model contract for the AI E2E matrix (verified against the bundled
 * pi-catalog, node_modules/@oh-my-pi/pi-catalog):
 * - Provider id is `opencode-go`, whose descriptor declares the env var
 *   `OPENCODE_API_KEY` (src/provider-models/descriptors.ts:329-332).
 * - `opencode-go/deepseek-v4-flash` is a valid openai-completions model
 *   (src/models.json:66502-66511) and serves every non-vision role.
 * - `opencode-go/minimax-m3` is the vision-capable MiniMax model
 *   (input ["text","image"], src/models.json:67021-67031).
 * NOTE: `opencode-go/minimax-m2.5` EXISTS but its catalog input is ["text"]
 * only (src/models.json:66960-66969) — it can never serve modelRoles.vision.
 */
export const AI_PUBLIC_DEFAULTS = {
  provider: 'opencode-go',
  baseModel: 'deepseek-v4-flash',
  visualModel: 'minimax-m3',
} as const;

const BASE_ROLES = ['default', 'smol', 'slow', 'plan', 'designer', 'commit', 'tiny', 'task', 'advisor'] as const;
const MAX_BROWSER_OUTPUT = 96 * 1024;
const SCREEN_EVAL = `(() => {
  const term = window.__uxTerm;
  if (!term) return "";
  const lines = [];
  const count = term.rows ?? term.buffer.active.length;
  for (let i = 0; i < count; i += 1) {
    lines.push(term.buffer.active.getLine(i)?.translateToString(true) ?? "");
  }
  return JSON.stringify(lines.join("\\n"));
})()`;

export type AiPhase =
  | 'provision'
  | 'bootstrap'
  | 'config'
  | 'start'
  | 'browser-open'
  | 'partial-picker'
  | 'tab'
  | 'task-submit'
  | 'agent-start'
  | 'completion'
  | 'teardown'
  | 'artifact-scan';

export interface CommandScenario {
  readonly id: string;
  readonly pickerPrefix: string;
  readonly commandArgs: string;
  readonly instruction: string;
  readonly startPatterns: readonly string[];
  readonly errorPatterns: readonly string[];
}

export interface AiCommandManifest {
  readonly schemaVersion: 1;
  readonly guide: string;
  readonly registryRoot: string;
  readonly promptTemplate: string;
  readonly commands: readonly CommandScenario[];
}

export interface AiModelConfig {
  readonly publicProvider: string;
  readonly baseModel: string;
  readonly visualModel: string;
  readonly apiKey: string | undefined;
  readonly modelRoles: Readonly<Record<string, string>>;
}

export interface BrowserClient {
  open(url: string, timeoutMs?: number): Promise<void>;
  setCookieFile(path: string, timeoutMs?: number): Promise<void>;
  keyboardType(text: string, timeoutMs?: number): Promise<void>;
  press(key: string, timeoutMs?: number): Promise<void>;
  evaluate(script: string, timeoutMs?: number): Promise<string>;
  close(timeoutMs?: number): Promise<void>;
}

export interface AiRunnerDependencies {
  readonly bootstrap: (args: BootstrapArgs) => string;
  readonly start: (options: TestSessionOptions) => Promise<TestSession>;
  readonly browser: (sessionName: string) => BrowserClient;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly now: () => number;
}

export interface AiCommandRunnerOptions {
  readonly monorepoRoot?: string;
  readonly workdir?: string;
  readonly outputDir?: string;
  readonly manifestPath?: string;
  readonly guidePath?: string;
  readonly ompBinary?: string;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly runId?: string;
  readonly perCommandTimeoutMs?: number;
  readonly startupTimeoutMs?: number;
  readonly pickerTimeoutMs?: number;
  readonly startTimeoutMs?: number;
  readonly typingDelayMs?: number;
  readonly startGraceMs?: number;
}

export interface AiCommandCaseResult {
  readonly command: string;
  readonly status: 'passed' | 'failed';
  readonly phase: AiPhase;
  readonly durationMs: number;
  readonly evidence: readonly string[];
  readonly error?: string;
  readonly teardown: 'clean' | 'failed';
}

export interface AiCommandRunReport {
  readonly schema_version: 1;
  readonly status: 'passed' | 'failed';
  readonly started_at: string;
  readonly finished_at: string;
  readonly config: {
    readonly provider: string;
    readonly base_model: string;
    readonly visual_model: string;
    readonly command_count: number;
  };
  readonly cases: readonly AiCommandCaseResult[];
  readonly artifact_scan: 'passed' | 'failed';
}

class AiPhaseError extends Error {
  readonly phase: AiPhase;

  constructor(phase: AiPhase, message: string) {
    super(message);
    this.name = 'AiPhaseError';
    this.phase = phase;
  }
}

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), '..');
}

export function defaultMonorepoRoot(): string {
  return resolve(packageRoot(), '..', '..');
}

export function defaultManifestPath(): string {
  return join(packageRoot(), 'scenarios', 'ai-command-manifest.json');
}

export function defaultGuidePath(manifestPath = defaultManifestPath()): string {
  const manifest = readJson(manifestPath) as { guide?: unknown };
  return join(dirname(manifestPath), typeof manifest.guide === 'string' ? manifest.guide : 'ai-command-e2e-guide.md');
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, 'utf8')) as unknown;
}

function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`AI E2E: ${label} must be an object`);
  }
  return value as Record<string, unknown>;
}
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/u;

function safeString(value: unknown, label: string, maxLength: number): string {
  const result = requiredString(value, label);
  if (result.length > maxLength) throw new Error(`AI E2E: ${label} exceeds ${String(maxLength)} characters`);
  if (CONTROL_CHARS.test(result)) throw new Error(`AI E2E: ${label} contains control characters`);
  return result;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`AI E2E: ${label} must be a non-empty string`);
  }
  return value.trim();
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`AI E2E: ${label} must be a non-empty string array`);
  }
  return value.map((item, index) => safeString(item, `${label}[${String(index)}]`, 1_024));
}

export function loadAiCommandManifest(path = defaultManifestPath()): AiCommandManifest {
  const raw = asRecord(readJson(path), path);
  if (raw.schema_version !== 1) throw new Error(`AI E2E: ${path} has unsupported schema_version`);
  const commandsRaw = raw.commands;
  if (!Array.isArray(commandsRaw) || commandsRaw.length === 0) throw new Error(`AI E2E: ${path} has no commands`);
  const commands = commandsRaw.map((item, index): CommandScenario => {
    const command = asRecord(item, `${path}.commands[${index}]`);
    return {
      id: safeString(command.id, `${path}.commands[${index}].id`, 128),
      pickerPrefix: safeString(command.picker_prefix, `${path}.commands[${index}].picker_prefix`, 128),
      commandArgs: safeString(command.command_args, `${path}.commands[${index}].command_args`, 512),
      instruction: safeString(command.instruction, `${path}.commands[${index}].instruction`, 4_096),
      startPatterns: stringArray(command.start_patterns, `${path}.commands[${index}].start_patterns`),
      errorPatterns: stringArray(command.error_patterns, `${path}.commands[${index}].error_patterns`),
    };
  });
  return {
    schemaVersion: 1,
    guide: safeString(raw.guide, `${path}.guide`, 256),
    registryRoot: safeString(raw.registry_root, `${path}.registry_root`, 256),
    promptTemplate: safeString(raw.prompt_template, `${path}.prompt_template`, 16_384),
    commands,
  };
}
function resolveContainedPath(root: string, candidate: string, label: string): string {
  const rootPath = resolve(root);
  const targetPath = resolve(rootPath, candidate);
  const relativePath = relative(rootPath, targetPath);
  if (relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
    throw new Error(`AI E2E: ${label} must stay inside ${rootPath}`);
  }
  return targetPath;
}

export function discoverCommandIds(monorepoRoot: string): readonly string[] {
  const commandRoot = resolve(monorepoRoot, 'packages', 'fullstack', 'commands');
  if (!existsSync(commandRoot)) throw new Error(`AI E2E: command registry does not exist: ${commandRoot}`);
  return readdirSync(commandRoot, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export function validateAiCommandManifest(manifest: AiCommandManifest, discoveredIds: readonly string[]): void {
  const manifestIds = manifest.commands.map(command => command.id);
  const duplicateIds = manifestIds.filter((id, index) => manifestIds.indexOf(id) !== index);
  if (duplicateIds.length > 0) throw new Error(`AI E2E: duplicate manifest command(s): ${[...new Set(duplicateIds)].join(', ')}`);
  const missing = discoveredIds.filter(id => !manifestIds.includes(id));
  const extra = manifestIds.filter(id => !discoveredIds.includes(id));
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(`AI E2E: command coverage mismatch (missing: ${missing.join(', ') || 'none'}; extra: ${extra.join(', ') || 'none'})`);
  }
  const seenPrefixes = new Set<string>();
  for (const command of manifest.commands) {
    if (!command.id.startsWith(command.pickerPrefix)) {
      throw new Error(`AI E2E: picker prefix for ${command.id} is not a prefix of the command name`);
    }
    if (seenPrefixes.has(command.pickerPrefix)) throw new Error(`AI E2E: duplicate picker prefix: ${command.pickerPrefix}`);
    if (manifestIds.some(id => id !== command.id && id.startsWith(command.pickerPrefix))) {
      throw new Error(`AI E2E: picker prefix for ${command.id} matches another command`);
    }
    seenPrefixes.add(command.pickerPrefix);
  }
}

/**
 * VERIFIED FAIL-CLOSED ALLOWLIST of vision-capable opencode-go models,
 * derived from the bundled pi-catalog (entries whose `input` advertises
 * `["text","image"]`):
 *   minimax-m3  src/models.json:67021-67031
 *   kimi-k2.5   src/models.json:66712-66722
 *   mimo-v2.5   src/models.json:66899-66909
 * This table is a deliberate freeze of the ids verified at the pinned
 * catalog version, not a live mirror of it — the catalog may grow. A
 * configured visual model MUST be in this table: anything else (including
 * text-only ids such as minimax-m2.5) is rejected, never silently accepted
 * or substituted.
 */
const VISION_CAPABLE_MODELS: Record<string, true> = {
  'minimax-m3': true,
  'kimi-k2.5': true,
  'mimo-v2.5': true,
};

export function resolveAiModelConfig(env: Readonly<Record<string, string | undefined>> = process.env): AiModelConfig {
  // OMP_API_PROVIDER / OMP_BASE_MODEL / OMP_VISUAL_MODEL are RUNNER-INTERNAL
  // overrides read from the runner's own environment (CI sets them). OMP
  // itself does not read these names — the spawned omp process is configured
  // exclusively through the `--config` modelRoles overlay (see the spawn site
  // and server.ts); these env names are never forwarded to the PTY.
  const publicProvider = env.OMP_API_PROVIDER?.trim() || AI_PUBLIC_DEFAULTS.provider;
  const baseModel = env.OMP_BASE_MODEL?.trim() || AI_PUBLIC_DEFAULTS.baseModel;
  const visualModel = env.OMP_VISUAL_MODEL?.trim() || AI_PUBLIC_DEFAULTS.visualModel;
  if (publicProvider !== AI_PUBLIC_DEFAULTS.provider) {
    throw new Error(
      `AI E2E: unsupported OMP_API_PROVIDER "${publicProvider}"; the expected provider id is "${AI_PUBLIC_DEFAULTS.provider}" (bare "opencode" is not a valid OMP_API_PROVIDER value)`,
    );
  }
  if (baseModel !== AI_PUBLIC_DEFAULTS.baseModel) throw new Error(`AI E2E: unsupported OMP_BASE_MODEL "${baseModel}"`);
  if (VISION_CAPABLE_MODELS[visualModel] !== true) {
    if (visualModel === 'minimax-m2.5') {
      throw new Error(
        'AI E2E: OMP_VISUAL_MODEL "minimax-m2.5" cannot serve modelRoles.vision: pi-catalog marks opencode-go/minimax-m2.5 input as ["text"] only (node_modules/@oh-my-pi/pi-catalog/src/models.json:66960-66969). Pick a vision-capable opencode-go model: minimax-m3, kimi-k2.5, mimo-v2.5.',
      );
    }
    throw new Error(
      `AI E2E: unsupported OMP_VISUAL_MODEL "${visualModel}"; expected a vision-capable opencode-go model (minimax-m3, kimi-k2.5, mimo-v2.5 per pi-catalog models.json)`,
    );
  }
  const baseSelector = `opencode-go/${baseModel}:high`;
  const visualSelector = `opencode-go/${visualModel}`;
  const modelRoles: Record<string, string> = {};
  for (const role of BASE_ROLES) modelRoles[role] = baseSelector;
  modelRoles.vision = visualSelector;
  return {
    publicProvider,
    baseModel,
    visualModel,
    apiKey: env.OPENCODE_API_KEY?.trim() || undefined,
    modelRoles,
  };
}

export function writeModelOverlay(path: string, config: AiModelConfig): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ modelRoles: config.modelRoles }, null, 2) + '\n', { mode: 0o600 });
}

export function renderCommandPrompt(template: string, command: CommandScenario): string {
  return template
    .replaceAll('{command}', command.id)
    .replaceAll('{instruction}', command.instruction);
}

export function redactSensitive(value: string, options: {
  readonly secret?: string;
  readonly paths?: readonly string[];
  readonly tokens?: readonly string[];
} = {}): string {
  let result = value;
  for (const path of options.paths ?? []) {
    if (path.length > 0) result = result.replaceAll(path, '<path>');
  }
  for (const token of [...(options.tokens ?? []), options.secret].filter((item): item is string => Boolean(item && item.length > 0))) {
    result = result.replaceAll(token, '<redacted>');
  }
  return result
    .replace(/\\?["']?((?:api[_-]?key|authorization|bearer|access[_-]?token|session[_-]?token|token))\\?["']?\s*[:=]\s*\\?["']?(?:bearer\s+)?(?!<redacted>|<path>)[^<\s\\'",;]{8,}/giu, '$1=<redacted>')
    .replace(/https?:\/\/[^\s)]+[?&](?:token|key|api[_-]?key)=(?!<redacted>)[^\s)&]+/giu, '<redacted-url>');
}

export function containsSensitive(value: string, options: {
  readonly secret?: string;
  readonly keyPatterns?: readonly RegExp[];
} = {}): boolean {
  if (options.secret && options.secret.length > 0 && value.includes(options.secret)) return true;
  const patterns = options.keyPatterns ?? [
    /(?:api[_-]?key|authorization|bearer|access[_-]?token|session[_-]?token|token)\s*[:=]\s*(?:bearer\s+)?(?!<redacted>|<path>)[^\s,;]{8,}/iu,
  ];
  return patterns.some(pattern => pattern.test(value));
}

class AgentBrowserCli implements BrowserClient {
  constructor(
    private readonly binary: string,
    private readonly sessionName: string,
    private readonly environment: NodeJS.ProcessEnv,
  ) {}

  private async run(command: readonly string[], timeoutMs = 20_000): Promise<string> {
    try {
      const result = await execFileAsync(this.binary, ['--session', this.sessionName, ...command], {
        timeout: timeoutMs,
        maxBuffer: MAX_BROWSER_OUTPUT,
        windowsHide: true,
        env: this.environment,
      });
      return result.stdout.toString().trim();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`agent-browser ${command[0] ?? 'command'} failed: ${message}`);
    }
  }

  async open(url: string, timeoutMs = 20_000): Promise<void> {
    await this.run(['open', url], timeoutMs);
  }

  async setCookieFile(path: string, timeoutMs = 20_000): Promise<void> {
    await this.run(['cookies', 'set', '--curl', path, '--domain', '127.0.0.1', '--path', '/', '--httpOnly', '--sameSite', 'Lax'], timeoutMs);
  }

  async keyboardType(text: string, timeoutMs = 20_000): Promise<void> {
    await this.run(['keyboard', 'type', text], timeoutMs);
  }

  async press(key: string, timeoutMs = 20_000): Promise<void> {
    await this.run(['press', key], timeoutMs);
  }

  async evaluate(script: string, timeoutMs = 20_000): Promise<string> {
    return await this.run(['eval', script], timeoutMs);
  }

  async close(timeoutMs = 20_000): Promise<void> {
    await this.run(['close'], timeoutMs);
  }
}

function defaultDependencies(options: AiCommandRunnerOptions, browserRoot: string): AiRunnerDependencies {
  const sourceEnvironment: NodeJS.ProcessEnv = { ...process.env, ...(options.env ?? {}) };
  const browserTmp = join(browserRoot, 'tmp');
  const browserRuntime = join(browserRoot, 'run');
  const browserEnvironment: NodeJS.ProcessEnv = {
    PATH: sourceEnvironment.PATH,
    CI: sourceEnvironment.CI,
    LANG: sourceEnvironment.LANG,
    LC_ALL: sourceEnvironment.LC_ALL,
    NO_COLOR: sourceEnvironment.NO_COLOR,
    TERM: sourceEnvironment.TERM,
    // agent-browser discovers the Chromium installed by `agent-browser install`
    // below the real HOME. Session names are unique per command, so retaining
    // HOME is safe while still keeping PTY/runtime state isolated.
    HOME: sourceEnvironment.HOME ?? homedir(),
    TMPDIR: browserTmp,
    TMP: browserTmp,
    TEMP: browserTmp,
    XDG_RUNTIME_DIR: browserRuntime,
  };
  return {
    bootstrap: runBootstrap,
    start: startTestSession,
    browser: sessionName =>
      new AgentBrowserCli(
        options.env?.AGENT_BROWSER_BIN || process.env.AGENT_BROWSER_BIN || 'agent-browser',
        sessionName,
        browserEnvironment,
      ),
    sleep: milliseconds => {
      const { promise, resolve: resolveSleep } = deferred<void>();
      setTimeout(resolveSleep, milliseconds);
      return promise;
    },
    now: () => Date.now(),
  };
}

function parseScreen(value: string): string {
  const raw = value.trim();
  if (raw.length === 0) return '';
  const lines = raw.split(/\r?\n/u).map(line => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line) continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed === 'string') return parsed;
      if (typeof parsed === 'object' && parsed !== null) {
        const record = parsed as Record<string, unknown>;
        for (const key of ['data', 'result', 'value']) {
          if (typeof record[key] === 'string') return record[key] as string;
        }
      }
    } catch {
      // agent-browser may return plain text; use it below.
    }
  }
  return raw;
}

function hasPattern(text: string, patterns: readonly string[]): boolean {
  const lower = text.toLocaleLowerCase();
  return patterns.some(pattern => lower.includes(pattern.toLocaleLowerCase()));
}
function hasNewPattern(text: string, baseline: string, patterns: readonly string[]): boolean {
  const lower = text.toLocaleLowerCase();
  const baselineLower = baseline.toLocaleLowerCase();
  return patterns.some(pattern => {
    const needle = pattern.toLocaleLowerCase();
    return lower.includes(needle) && !baselineLower.includes(needle);
  });
}

function hasPickerCandidate(screen: string, command: CommandScenario): boolean {
  return screen.split(/\r?\n/u).some(line => line.includes(command.id) && line.includes('❯'));
}

function hasFullCommand(screen: string, command: CommandScenario): boolean {
  const fullCommand = `/${command.id}`;
  return screen.split(/\r?\n/u).some(line => {
    const trimmed = line.trim();
    return trimmed === fullCommand || trimmed.startsWith(`${fullCommand} `) || trimmed.startsWith(`${fullCommand}\t`);
  });
}

function phaseFromError(error: unknown, fallback: AiPhase): AiPhase {
  return error instanceof AiPhaseError ? error.phase : fallback;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function waitForScreen(
  browser: BrowserClient,
  predicate: (screen: string) => boolean,
  deadline: number,
  phase: AiPhase,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<string> {
  let last = '';
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new AiPhaseError(phase, `timeout waiting for ${phase}`);
    try {
      last = parseScreen(await browser.evaluate(SCREEN_EVAL, Math.min(5_000, remaining)));
    } catch (error) {
      throw new AiPhaseError(phase, errorMessage(error));
    }
    if (predicate(last)) return last;
    await sleep(Math.min(250, Math.max(25, remaining)));
  }
}

async function typeHuman(
  browser: BrowserClient,
  text: string,
  typingDelayMs: number,
  deadline: number,
  sleep: (milliseconds: number) => Promise<void>,
): Promise<void> {
  for (const character of text) {
    if (deadline - Date.now() <= 0) throw new AiPhaseError('task-submit', 'timeout while typing task');
    await browser.keyboardType(character, Math.min(5_000, Math.max(1, deadline - Date.now())));
    if (typingDelayMs > 0) await sleep(typingDelayMs);
  }
}

function writeSessionFixture(scratchDir: string): void {
  const stateDir = join(scratchDir, '.work-state', 'features', 'ai-command-e2e');
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(
    join(stateDir, 'state.json'),
    JSON.stringify(
      {
        schema: 1,
        branch: 'ci/ai-command-e2e',
        classification: {
          type: 'FEATURE',
          complexity: 'QUICK',
          confidence: 'HIGH',
          workflow: 'lightweight',
          autonomous: true,
          autonomous_reason: 'AI E2E local fixture',
        },
        task: 'AI E2E local report fixture',
        workflow_override: false,
        issue: null,
        stage_cursor: 'summary',
        stages: [],
        artifacts: {},
        pause: { kind: 'done', reason: 'fixture' },
        updated_at: new Date().toISOString(),
      },
      null,
      2,
    ) + '\n',
    { mode: 0o600 },
  );
}

function ensureDeadline(deadline: number, phase: AiPhase): void {
  if (deadline - Date.now() <= 0) throw new AiPhaseError(phase, `per-command timeout in ${phase}`);
}

function phaseTimeout(deadline: number, phase: AiPhase, maximumMs: number): number {
  ensureDeadline(deadline, phase);
  return Math.max(1, Math.min(maximumMs, deadline - Date.now()));
}
async function closeSessionBounded(session: TestSession, timeoutMs: number): Promise<void> {
  let rejectTimeout: (reason?: unknown) => void = () => {};
  const timeout = new Promise<never>((_, reject) => {
    rejectTimeout = reject;
  });
  const timer = setTimeout(() => rejectTimeout(new Error(`session teardown timeout after ${timeoutMs}ms`)), timeoutMs);
  try {
    await Promise.race([session.close(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function runCase(
  command: CommandScenario,
  manifest: AiCommandManifest,
  options: Required<Pick<AiCommandRunnerOptions, 'monorepoRoot' | 'workdir' | 'ompBinary' | 'perCommandTimeoutMs' | 'startupTimeoutMs' | 'pickerTimeoutMs' | 'startTimeoutMs' | 'typingDelayMs' | 'startGraceMs'>> & { readonly runId: string; readonly outputDir: string; readonly model: AiModelConfig; readonly guidePath: string; readonly env: Readonly<Record<string, string | undefined>> },
  deps: AiRunnerDependencies,
): Promise<AiCommandCaseResult> {
  const startedAt = deps.now();
  const deadline = startedAt + options.perCommandTimeoutMs;
  const evidence: string[] = [];
  let phase: AiPhase = 'provision';
  let session: TestSession | null = null;
  let browser: BrowserClient | null = null;
  let teardown: 'clean' | 'failed' = 'clean';
  let status: 'passed' | 'failed' = 'failed';
  let failure: string | undefined;
  const slug = `ai-${options.runId}-${command.id}`;
  let scratchDir = join(options.workdir, `omp-ux-e2e-${slug}`);
  let cookieFile: string | null = null;

  try {
    phase = 'bootstrap';
    scratchDir = deps.bootstrap({
      ...parseBootstrapArgs([slug, `ci/ai-${command.id}`, '--workdir', options.workdir, '--monorepo', options.monorepoRoot, '--force']),
      omp: options.ompBinary,
    });
    evidence.push(`scratch=${scratchDir}`);
    ensureDeadline(deadline, phase);

    phase = 'config';
    const guideTarget = join(scratchDir, 'AI-E2E-GUIDE.md');
    writeFileSync(guideTarget, readFileSync(options.guidePath, 'utf8'), { mode: 0o600 });
    const overlayPath = join(scratchDir, '.omp', 'ux-e2e-overlay.user.json');
    writeModelOverlay(overlayPath, options.model);
    if (command.id === 'session-report') writeSessionFixture(scratchDir);
    const overlayText = readFileSync(overlayPath, 'utf8');
    if (containsSensitive(overlayText, { secret: options.model.apiKey })) {
      throw new AiPhaseError('config', 'model overlay contains a secret');
    }
    evidence.push(`overlay=${overlayPath}`);
    ensureDeadline(deadline, phase);

    phase = 'start';
    const runtimeRoot = join(scratchDir, '.runtime');
    const isolatedDirs = [
      join(scratchDir, '.home'),
      join(runtimeRoot, 'tmp'),
      join(runtimeRoot, 'config'),
      join(runtimeRoot, 'cache'),
      join(runtimeRoot, 'run'),
    ];
    for (const directory of isolatedDirs) mkdirSync(directory, { recursive: true, mode: 0o700 });
    // The spawned omp receives ONLY real environment (HOME/TMPDIR/XDG_*, PATH,
    // CI) plus the provider API key. OMP_API_PROVIDER / OMP_BASE_MODEL /
    // OMP_VISUAL_MODEL are runner-internal overrides read by
    // resolveAiModelConfig from the RUNNER's env (CI sets them); OMP does not
    // read those names (pi-coding-agent reads settings from config.yml +
    // `--config` overlays, src/config/settings.ts:1244-1262), so they must
    // never be passed to the PTY. The model contract reaches omp exclusively
    // through the modelRoles overlay written below.
    const sessionEnv: Record<string, string> = {
      HOME: join(scratchDir, '.home'),
      TMPDIR: join(runtimeRoot, 'tmp'),
      XDG_CONFIG_HOME: join(runtimeRoot, 'config'),
      XDG_CACHE_HOME: join(runtimeRoot, 'cache'),
      XDG_RUNTIME_DIR: join(runtimeRoot, 'run'),
      CI: 'true',
    };
    const pathValue = options.env.PATH ?? process.env.PATH;
    if (pathValue !== undefined) sessionEnv.PATH = pathValue;
    if (options.model.apiKey) sessionEnv.OPENCODE_API_KEY = options.model.apiKey;
    // Overlay wiring (real OMP contract): pi-coding-agent has NO `.user.json`
    // auto-discovery — overlays load only via the repeatable `--config` flag
    // (src/commands/launch.ts:82-85) or the PI_CONFIG_FILES env var
    // (src/config/settings.ts:381-383), merged by #loadConfigOverlays /
    // #loadOverlayYaml (src/config/settings.ts:1254-1286; YAML.parse at
    // settings.ts:1283 also accepts JSON). startTestSession emits the
    // overlayPath written above as the LAST `--config` in argv when the
    // file exists (packages/e2e/src/server.ts:1147-1172) — hostConfigPath
    // is null for this session, so the overlay is the final one and wins
    // on conflict — so omp boots with our modelRoles.
    session = await deps.start({
      cwd: scratchDir,
      surface: 'web',
      ompBinary: options.ompBinary,
      maxTimeSec: Math.ceil(options.perCommandTimeoutMs / 1000),
      idleMs: Math.max(30_000, options.perCommandTimeoutMs),
      env: sessionEnv,
      inheritEnv: false,
      hostConfigPath: null,
      taskPrompt: renderCommandPrompt(manifest.promptTemplate, command),
      scenario: { id: `ai-command-${command.id}`, title: `AI command ${command.id}` },
    });
    evidence.push(`session=${session.url.replace(/([?&](?:token|key)=)[^&]+/giu, '$1<redacted>')}`);
    ensureDeadline(Math.min(deadline, startedAt + options.startupTimeoutMs), 'start');
    phase = 'browser-open';
    browser = deps.browser(`ai-${options.runId}-${command.id}`);
    cookieFile = join(runtimeRoot, 'browser-cookie.txt');
    writeFileSync(cookieFile, `ux-e2e-token=${encodeURIComponent(session.token)}\n`, { mode: 0o600 });
    await browser.setCookieFile(cookieFile, phaseTimeout(deadline, phase, 20_000));
    const browserUrl = session.browserUrl;
    await browser.open(browserUrl, phaseTimeout(deadline, phase, 20_000));
    await browser.evaluate('document.querySelector(".xterm-helper-textarea")?.focus(); true', phaseTimeout(deadline, phase, 5_000));
    ensureDeadline(deadline, phase);

    phase = 'partial-picker';
    await typeHuman(browser, `/${command.pickerPrefix}`, options.typingDelayMs, deadline, deps.sleep);
    const pickerScreen = await waitForScreen(
      browser,
      screen => hasPickerCandidate(screen, command) && !hasPattern(screen, command.errorPatterns),
      Math.min(deadline, Date.now() + options.pickerTimeoutMs),
      phase,
      deps.sleep,
    );
    evidence.push(`picker=${pickerScreen}`);
    phase = 'tab';
    await browser.press('Tab', phaseTimeout(deadline, phase, 10_000));

    const tabScreen = await waitForScreen(
      browser,
      screen => hasFullCommand(screen, command) && !hasPattern(screen, command.errorPatterns),
      Math.min(deadline, Date.now() + options.pickerTimeoutMs),
      phase,
      deps.sleep,
    );
    evidence.push(`tab=${tabScreen}`);

    phase = 'task-submit';
    const task = ` ${command.commandArgs}`;
    await typeHuman(browser, task, options.typingDelayMs, deadline, deps.sleep);
    const beforeSubmitScreen = parseScreen(await browser.evaluate(SCREEN_EVAL, phaseTimeout(deadline, phase, 5_000)));
    await browser.press('Enter', phaseTimeout(deadline, phase, 10_000));
    ensureDeadline(deadline, phase);

    phase = 'agent-start';
    const startScreen = await waitForScreen(
      browser,
      screen => hasNewPattern(screen, beforeSubmitScreen, command.startPatterns) && !hasPattern(screen, command.errorPatterns),
      Math.min(deadline, Date.now() + options.startTimeoutMs),
      phase,
      deps.sleep,
    );
    evidence.push(`start=${startScreen}`);

    phase = 'completion';
    if (options.startGraceMs > 0) {
      ensureDeadline(deadline, phase);
      await deps.sleep(Math.min(options.startGraceMs, deadline - Date.now()));
    }
    const finalScreen = parseScreen(await browser.evaluate(SCREEN_EVAL, phaseTimeout(deadline, phase, 5_000)));
    evidence.push(`final=${finalScreen}`);
    status = 'passed';
  } catch (error) {
    failure = errorMessage(error);
    phase = phaseFromError(error, phase);
    if (browser) {
      try {
        evidence.push(`failure-screen=${parseScreen(await browser.evaluate(SCREEN_EVAL, 3_000))}`);
      } catch {
        // Browser may already have exited; the phase error is retained.
      }
    }
  } finally {
    if (browser) {
      try {
        await browser.close(10_000);
      } catch (error) {
        teardown = 'failed';
        if (!failure) phase = 'teardown';
        failure = `${failure ? `${failure}; ` : ''}browser teardown: ${errorMessage(error)}`;
      }
    }
    if (session) {
      try {
        await closeSessionBounded(session, 10_000);
      } catch (error) {
        teardown = 'failed';
        if (!failure) phase = 'teardown';
        failure = `${failure ? `${failure}; ` : ''}PTY teardown: ${errorMessage(error)}`;
      }
    }
    if (cookieFile !== null) {
      try {
        unlinkSync(cookieFile);
      } catch (error) {
        if (existsSync(cookieFile)) {
          teardown = 'failed';
          if (!failure) phase = 'teardown';
          failure = `${failure ? `${failure}; ` : ''}cookie cleanup: ${errorMessage(error)}`;
        }
      }
    }
    const sessionJsonPath = session?.sessionJsonPath;
    if (sessionJsonPath !== undefined) {
      try {
        unlinkSync(sessionJsonPath);
      } catch (error) {
        if (existsSync(sessionJsonPath)) {
          teardown = 'failed';
          if (!failure) phase = 'teardown';
          failure = `${failure ? `${failure}; ` : ''}session metadata cleanup: ${errorMessage(error)}`;
        }
      }
    }
  }

  const sanitizedEvidence = evidence.map(item => redactSensitive(item, {
    secret: options.model.apiKey,
    paths: [options.monorepoRoot, scratchDir, options.workdir],
    tokens: session ? [session.token] : [],
  })).map(item => item.length > 12_000 ? `${item.slice(0, 12_000)}…` : item);
  return {
    command: command.id,
    status: status === 'passed' && teardown === 'clean' ? 'passed' : 'failed',
    phase: status === 'passed' && teardown === 'clean' ? 'completion' : phase,
    durationMs: deps.now() - startedAt,
    evidence: sanitizedEvidence,
    ...(failure ? { error: redactSensitive(failure, { secret: options.model.apiKey, paths: [options.monorepoRoot, scratchDir, options.workdir], tokens: session ? [session.token] : [] }) } : {}),
    teardown,
  };
}

function requiredOptions(options: AiCommandRunnerOptions, model: AiModelConfig, guidePath: string): Required<Pick<AiCommandRunnerOptions, 'monorepoRoot' | 'workdir' | 'ompBinary' | 'perCommandTimeoutMs' | 'startupTimeoutMs' | 'pickerTimeoutMs' | 'startTimeoutMs' | 'typingDelayMs' | 'startGraceMs'>> & { readonly runId: string; readonly outputDir: string; readonly model: AiModelConfig; readonly guidePath: string; readonly env: Readonly<Record<string, string | undefined>> } {
  const env = options.env ?? process.env;
  return {
    monorepoRoot: options.monorepoRoot ?? defaultMonorepoRoot(),
    workdir: options.workdir ?? env.RUNNER_TEMP ?? tmpdir(),
    ompBinary: options.ompBinary ?? env.OMP_BIN ?? 'omp',
    perCommandTimeoutMs: options.perCommandTimeoutMs ?? 120_000,
    startupTimeoutMs: options.startupTimeoutMs ?? 65_000,
    pickerTimeoutMs: options.pickerTimeoutMs ?? 20_000,
    startTimeoutMs: options.startTimeoutMs ?? 35_000,
    typingDelayMs: options.typingDelayMs ?? 80,
    startGraceMs: options.startGraceMs ?? 1_000,
    runId: options.runId ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
    // Local runs without an explicit artifact dir or CI's AI_E2E_ARTIFACT_DIR
    // write evidence to an OS temp dir (never the checkout), so secret-bearing
    // report artifacts cannot be staged accidentally.
    outputDir: options.outputDir ?? env.AI_E2E_ARTIFACT_DIR ?? join(tmpdir(), 'omp-ai-command-e2e'),
    model,
    guidePath,
    env,
  };
}

export async function runAiCommandMatrix(
  options: AiCommandRunnerOptions = {},
  injectedDependencies?: Partial<AiRunnerDependencies>,
): Promise<AiCommandRunReport> {
  const manifestPath = options.manifestPath ?? defaultManifestPath();
  const manifest = loadAiCommandManifest(manifestPath);
  const manifestRoot = dirname(resolve(manifestPath));
  const guidePath = resolveContainedPath(manifestRoot, options.guidePath ?? manifest.guide, 'guide path');
  if (!existsSync(guidePath)) throw new Error(`AI E2E: guide does not exist: ${guidePath}`);
  const model = resolveAiModelConfig(options.env ?? process.env);
  if (!model.apiKey) throw new Error('AI E2E: OPENCODE_API_KEY is required for a live AI run');
  const resolved = requiredOptions(options, model, guidePath);
  const expectedRegistryRoot = resolve(resolved.monorepoRoot, 'packages', 'fullstack', 'commands');
  const manifestRegistryRoot = resolve(manifestRoot, manifest.registryRoot);
  if (manifestRegistryRoot !== expectedRegistryRoot) {
    throw new Error(`AI E2E: registry root must resolve to ${expectedRegistryRoot}`);
  }
  const discovered = discoverCommandIds(resolved.monorepoRoot);
  validateAiCommandManifest(manifest, discovered);
  mkdirSync(resolved.outputDir, { recursive: true });
  const browserRoot = join(resolved.workdir, `.omp-ai-browser-${resolved.runId}`);
  for (const directory of ['tmp', 'run']) {
    mkdirSync(join(browserRoot, directory), { recursive: true, mode: 0o700 });
  }
  const deps = { ...defaultDependencies(options, browserRoot), ...injectedDependencies };
  const startedAt = new Date().toISOString();
  const cases: AiCommandCaseResult[] = [];
  for (const id of discovered) {
    const command = manifest.commands.find(item => item.id === id);
    if (!command) throw new Error(`AI E2E: command ${id} disappeared after manifest validation`);
    cases.push(await runCase(command, manifest, resolved, deps));
  }
  const finishedAt = new Date().toISOString();
  const reportBase: AiCommandRunReport = {
    schema_version: 1,
    status: cases.every(item => item.status === 'passed') ? 'passed' : 'failed',
    started_at: startedAt,
    finished_at: finishedAt,
    config: {
      provider: model.publicProvider,
      base_model: model.baseModel,
      visual_model: model.visualModel,
      command_count: cases.length,
    },
    cases,
    artifact_scan: 'passed',
  };
  const reportText = redactSensitive(JSON.stringify(reportBase, null, 2) + '\n', {
    secret: model.apiKey,
    paths: [resolved.monorepoRoot, resolved.workdir],
  });
  if (containsSensitive(reportText, { secret: model.apiKey })) {
    const failedReport = { ...reportBase, status: 'failed' as const, artifact_scan: 'failed' as const };
    return failedReport;
  }
  writeFileSync(join(resolved.outputDir, 'ai-command-report.json'), reportText, { mode: 0o600 });
  const markdown = [
    '# AI command E2E report',
    '',
    `Status: **${reportBase.status.toUpperCase()}**`,
    '',
    '| Command | Status | Phase | Duration | Teardown |',
    '| --- | --- | --- | ---: | --- |',
    ...cases.map(item => `| ${item.command} | ${item.status} | ${item.phase} | ${item.durationMs} ms | ${item.teardown} |`),
    '',
    'The raw PTY transcript and API credentials are not uploaded. Evidence above is bounded and redacted.',
    '',
  ].join('\n');
  writeFileSync(join(resolved.outputDir, 'ai-command-report.md'), redactSensitive(markdown, { secret: model.apiKey, paths: [resolved.monorepoRoot, resolved.workdir] }), { mode: 0o600 });
  return reportBase;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Usage: ai-command-runner [--help]\nRuns the real visual OMP + agent-browser command matrix.');
    return 0;
  }
  try {
    const report = await runAiCommandMatrix();
    for (const item of report.cases) console.log(`${item.command}: ${item.status} (${item.phase})`);
    return report.status === 'passed' && report.artifact_scan === 'passed' ? 0 : 1;
  } catch (error) {
    console.error(`AI E2E failed: ${errorMessage(error)}`);
    return 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => {
    process.exitCode = code;
  });
}
