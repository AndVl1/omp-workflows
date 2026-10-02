/**
 * H1/H2/H3 preparation only.
 *
 * H execution remains on the existing ux-e2e PTY/WS runner. This module
 * validates the finite plan, installs one pinned OMP runtime with candidate
 * workflow packages, reuses `runBootstrap`, and stops only owned sessions.
 * It never launches a host case or treats transcript prose as registration.
 */

import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runBootstrap, runStop } from './cli.js';

type JsonRecord = Record<string, unknown>;
type CaseId = 'H1' | 'H2' | 'H3';

interface HostCase {
  readonly id: CaseId;
  readonly title: string;
  readonly route: string;
  readonly registered_inputs: ReadonlyArray<{ readonly kind: string; readonly value: string }>;
  readonly expected_events: readonly string[];
  readonly required_registered_tools: readonly string[];
}

interface HostSmokePlan {
  readonly schema: 'reliable-stage-host-smoke/v2';
  readonly change: 'reliable-stage-execution';
  readonly runtime: {
    readonly omp_package: string;
    readonly pinned_version: '18.0.6';
    readonly candidate_core_env: string;
    readonly candidate_fullstack_env: string;
    readonly run_variant: 'pinned-omp-candidate-plugins';
    readonly candidate_plugins_required: true;
  };
  readonly install: {
    readonly isolated_prefix: string;
    readonly isolated_project_per_case: true;
    readonly network_policy: string;
    readonly credentials_policy: string;
    readonly package_store_policy: string;
    readonly omp_install: string;
  };
  readonly limits: {
    readonly attempt_timeout_sec: 900;
    readonly idle_watchdog_sec: number;
    readonly startup_grace_sec: number;
    readonly max_attempts_per_case: 2;
    readonly retry_requires_diagnosis: true;
    readonly retry_requires_changed_condition: true;
  };
  readonly evidence: {
    readonly format: 'jsonl';
    readonly sources: readonly string[];
    readonly registration_source: string;
    readonly canonical_oracles: string;
    readonly transcript_is_not_registration_proof: true;
    readonly safe_fields_only: true;
  };
  readonly cleanup: {
    readonly stop_owned_runtime: true;
    readonly retain_evidence: true;
    readonly remove_root_by_default: false;
    readonly never_kill_by_name: true;
    readonly never_touch_foreign_processes: true;
  };
  readonly cases: readonly HostCase[];
}

interface RuntimeManifest {
  readonly schema: 'reliable-stage-host-smoke/runtime/v2';
  readonly root: string;
  readonly omp_binary: string;
  readonly omp_version: string;
  readonly core_package: string;
  readonly core_version: string;
  readonly core_tarball_sha256: string;
  readonly fullstack_package: string;
  readonly fullstack_version: string;
  readonly fullstack_tarball_sha256: string;
  readonly scratch: Readonly<Record<CaseId, string>>;
}

const PLAN_PATH = fileURLToPath(new URL('../scenarios/reliable-stage-host-smoke.json', import.meta.url));
const PLAN = JSON.parse(readFileSync(PLAN_PATH, 'utf8')) as HostSmokePlan;
const CASE_IDS: readonly CaseId[] = ['H1', 'H2', 'H3'];

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  const value = index >= 0 ? process.argv[index + 1] : undefined;
  return value !== undefined && !value.startsWith('--') ? value : undefined;
}

function requiredArg(name: string): string {
  const value = arg(name);
  if (value === undefined || value.length === 0) throw new Error(`host-smoke: missing ${name}`);
  return value;
}

function asRecord(value: unknown): JsonRecord | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as JsonRecord;
}

function ensureDir(path: string): void {
  mkdirSync(path, { recursive: true });
}

function writeJson(path: string, value: unknown): void {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function appendEvidence(path: string, event: JsonRecord): void {
  ensureDir(dirname(path));
  appendFileSync(path, `${JSON.stringify({ ts: new Date().toISOString(), ...event })}\n`);
}

function validatePlan(): void {
  if (PLAN.schema !== 'reliable-stage-host-smoke/v2' || PLAN.change !== 'reliable-stage-execution') {
    throw new Error('host-smoke: unexpected plan schema/change');
  }
  if (PLAN.runtime.omp_package !== '@oh-my-pi/pi-coding-agent' || PLAN.runtime.pinned_version !== '18.0.6') {
    throw new Error('host-smoke: OMP must be pinned to @oh-my-pi/pi-coding-agent 18.0.6');
  }
  if (PLAN.runtime.run_variant !== 'pinned-omp-candidate-plugins' || !PLAN.runtime.candidate_plugins_required) {
    throw new Error('host-smoke: candidate core/fullstack packages are required');
  }
  if (PLAN.install.isolated_prefix !== 'runtime' || !PLAN.install.isolated_project_per_case || PLAN.install.omp_install !== '@oh-my-pi/pi-coding-agent@18.0.6') {
    throw new Error('host-smoke: isolated installation contract changed');
  }
  if (PLAN.limits.attempt_timeout_sec !== 900 || PLAN.limits.idle_watchdog_sec < 900 || PLAN.limits.max_attempts_per_case !== 2 || !PLAN.limits.retry_requires_diagnosis || !PLAN.limits.retry_requires_changed_condition) {
    throw new Error('host-smoke: 15-minute/one-diagnosed-retry contract changed');
  }
  if (PLAN.cases.length !== CASE_IDS.length || PLAN.cases.map(item => item.id).join(',') !== CASE_IDS.join(',')) {
    throw new Error('host-smoke: exactly H1/H2/H3 are required');
  }
  for (const item of PLAN.cases) {
    if (item.registered_inputs.length === 0 || item.expected_events.length === 0 || item.required_registered_tools.length === 0) {
      throw new Error(`host-smoke: ${item.id} is incomplete`);
    }
    for (const input of item.registered_inputs) {
      if (input.kind === 'slash_command' && !input.value.startsWith('/')) throw new Error(`host-smoke: ${item.id} slash input is not registered`);
      if (input.value.includes('\n')) throw new Error(`host-smoke: ${item.id} input is multiline`);
    }
    if (item.id === 'H1' && (item.registered_inputs[1]?.kind !== 'human_text' || item.registered_inputs[1]?.value !== 'Proceed')) {
      throw new Error('host-smoke: H1 must continue with literal Proceed in the same session');
    }
    if (item.id === 'H2' && (item.registered_inputs[1]?.kind !== 'human_text' || item.registered_inputs[1]?.value !== 'END')) {
      throw new Error('host-smoke: H2 must use the exact human END request');
    }
  }
  if (PLAN.evidence.registration_source.includes('transcript') || !PLAN.evidence.transcript_is_not_registration_proof || !PLAN.evidence.safe_fields_only) {
    throw new Error('host-smoke: transcript cannot prove registration and evidence must be safe');
  }
  if (!PLAN.cleanup.retain_evidence || PLAN.cleanup.remove_root_by_default || !PLAN.cleanup.never_kill_by_name) {
    throw new Error('host-smoke: cleanup must retain evidence and avoid name-based kills');
  }
}

function scrubInstallEnv(root: string): NodeJS.ProcessEnv {
  // Parent npm lifecycle/profile selectors must not redirect postinstall writes.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? 'C',
    CI: '1',
    NO_COLOR: '1',
  };
  const home = join(root, 'home');
  const cache = join(root, 'npm-cache');
  const temporary = join(root, 'tmp');
  ensureDir(home);
  ensureDir(cache);
  ensureDir(temporary);
  env.HOME = home;
  env.TMPDIR = temporary;
  env.TMP = temporary;
  env.TEMP = temporary;
  env.XDG_CONFIG_HOME = join(root, 'xdg-config');
  env.XDG_CACHE_HOME = join(root, 'xdg-cache');
  env.OMP_HOME = join(root, 'omp-home');
  env.PI_CODING_AGENT_DIR = join(root, 'agent-data');
  env.PI_CONFIG_DIR = '.omp';
  env.OMP_PROJECT_DIR = join(root, PLAN.install.isolated_prefix);
  env.INIT_CWD = root;
  env.npm_config_cache = cache;
  const userConfig = join(root, 'npmrc');
  env.NPM_CONFIG_USERCONFIG = userConfig;
  writeFileSync(userConfig, `cache=${cache}\nupdate-notifier=false\nfund=false\naudit=false\n`);
  return env;
}

function run(command: string, args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const result = spawnSync(command, [...args], { cwd, env, stdio: 'ignore', timeout: 120_000 });
  if (result.error !== undefined || result.status !== 0) throw new Error(`host-smoke: ${command} setup command failed`);
}

function installedPackage(prefix: string, name: string): string {
  const path = join(prefix, 'node_modules', ...name.split('/'));
  if (!existsSync(join(path, 'package.json'))) throw new Error(`host-smoke: installed package missing: ${name}`);
  return path;
}
function fileSha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function packageVersion(packageRoot: string): string {
  const packageJson = asRecord(JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8')) as unknown);
  if (typeof packageJson?.version !== 'string' || packageJson.version.length === 0) throw new Error(`host-smoke: package version missing at ${packageRoot}`);
  return packageJson.version;
}

function ompVersion(binary: string, env: NodeJS.ProcessEnv): string {
  const result = spawnSync(binary, ['--version'], { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  if (result.error !== undefined || result.status !== 0) throw new Error('host-smoke: installed OMP did not answer --version');
  const version = String(result.stdout ?? '').trim().split('\n')[0] ?? '';
  if (!/18\.0\.6/u.test(version)) throw new Error(`host-smoke: installed OMP reported ${version || 'empty version'}`);
  return version;
}

function writeCandidateLayout(root: string, corePackage: string, fullstackPackage: string): string {
  const layout = join(root, 'candidate-layout');
  const packages = join(layout, 'packages');
  ensureDir(packages);
  const coreLink = join(packages, 'core');
  const fullstackLink = join(packages, 'fullstack');
  if (!existsSync(coreLink)) symlinkSync(corePackage, coreLink, 'dir');
  if (!existsSync(fullstackLink)) symlinkSync(fullstackPackage, fullstackLink, 'dir');
  writeJson(join(layout, '.omp', 'team.config.json'), {
    roles: { frontend: 'frontend-developer', 'code-reviewer': 'code-reviewer', qa: 'qa' },
    scope_map: [{ glob: ['**/*.ts', '*.ts'], scope: 'frontend', dev_agent: 'frontend-developer' }],
  });
  return layout;
}

function commitScratch(scratch: string, installEnv: NodeJS.ProcessEnv): void {
  const env: NodeJS.ProcessEnv = {
    ...installEnv,
    GIT_AUTHOR_NAME: 'Reliable stage host smoke',
    GIT_AUTHOR_EMAIL: 'host-smoke@example.invalid',
    GIT_COMMITTER_NAME: 'Reliable stage host smoke',
    GIT_COMMITTER_EMAIL: 'host-smoke@example.invalid',
  };
  for (const args of [['add', '-A'], ['commit', '-m', 'host smoke baseline']] as const) {
    const result = spawnSync('git', [...args], { cwd: scratch, env, stdio: 'ignore' });
    if (result.error !== undefined || result.status !== 0) throw new Error(`host-smoke: git ${args[0]} failed`);
  }
}

function assertOwnedRoot(root: string): void {
  const ownerPath = join(root, '.host-smoke-owner.json');
  if (!existsSync(ownerPath)) throw new Error('host-smoke: refusing an unowned root');
  const owner = asRecord(JSON.parse(readFileSync(ownerPath, 'utf8')) as unknown);
  if (owner?.schema !== 'reliable-stage-host-smoke/owner/v2' || owner.root !== root) {
    throw new Error('host-smoke: owner marker mismatch');
  }
}

function prepareRoot(root: string): void {
  const ownerPath = join(root, '.host-smoke-owner.json');
  if (existsSync(root)) {
    const entries = readdirSync(root, { withFileTypes: true });
    if (entries.length > 0) {
      assertOwnedRoot(root);
      if (existsSync(join(root, 'runtime-manifest.json'))) {
        throw new Error('host-smoke: runtime already prepared; refusing to overwrite candidate evidence');
      }
      for (const name of ['runtime', 'candidate-layout', 'scratch', 'home', 'npm-cache', 'tmp', 'xdg-config', 'xdg-cache', 'omp-home', 'agent-data', 'npmrc']) {
        rmSync(join(root, name), { recursive: true, force: true });
      }
    }
  }
  ensureDir(root);
  writeJson(ownerPath, { schema: 'reliable-stage-host-smoke/owner/v2', root });
}

function prepare(rootInput: string, coreTarball: string, fullstackTarball: string): void {
  validatePlan();
  const root = resolve(rootInput);
  const coreTarballPath = resolve(coreTarball);
  const fullstackTarballPath = resolve(fullstackTarball);
  if (!existsSync(coreTarballPath) || !existsSync(fullstackTarballPath)) throw new Error('host-smoke: candidate package tarball is missing');
  prepareRoot(root);
  const evidence = join(root, 'install-evidence.jsonl');
  const env = scrubInstallEnv(root);
  const prefix = join(root, PLAN.install.isolated_prefix);
  ensureDir(prefix);
  run('npm', ['init', '--yes', '--prefix', prefix], root, env);
  run('npm', ['install', '--prefix', prefix, '--package-lock=false', '--no-save', PLAN.install.omp_install, coreTarballPath, fullstackTarballPath], root, env);
  const binary = join(prefix, 'node_modules', '.bin', 'omp');
  if (!existsSync(binary)) throw new Error('host-smoke: isolated OMP binary is missing');
  const version = ompVersion(binary, env);
  const corePackage = installedPackage(prefix, '@andvl1/omp-workflows-core');
  const fullstackPackage = installedPackage(prefix, '@andvl1/omp-workflows-fullstack');
  const coreVersion = packageVersion(corePackage);
  const fullstackVersion = packageVersion(fullstackPackage);
  const coreTarballSha256 = fileSha256(coreTarballPath);
  const fullstackTarballSha256 = fileSha256(fullstackTarballPath);
  appendEvidence(evidence, {
    phase: 'install',
    status: 'PASS',
    omp_spec: PLAN.install.omp_install,
    omp_version: version,
    candidate_core: { path: relative(root, corePackage), version: coreVersion, tarball_sha256: coreTarballSha256 },
    candidate_fullstack: { path: relative(root, fullstackPackage), version: fullstackVersion, tarball_sha256: fullstackTarballSha256 },
  });
  const layout = writeCandidateLayout(root, corePackage, fullstackPackage);
  const scratchRoot = join(root, 'scratch');
  const scratch = {} as Record<CaseId, string>;
  for (const id of CASE_IDS) {
    const slug = id.toLowerCase();
    scratch[id] = runBootstrap({ slug, branch: `host-smoke/${slug}`, workdir: scratchRoot, omp: binary, monorepo: layout, force: false }, env);
    if (id === 'H2') {
      writeJson(join(scratch[id], '.omp', 'teams.json'), [{
        id: 'frontend',
        name: 'Frontend',
        scope: ['frontend'],
        profile: 'lightweight',
        lead: 'team-lead',
        roster: ['frontend', 'code-reviewer', 'qa'],
      }]);
    }
    commitScratch(scratch[id], env);
  }
  const manifest: RuntimeManifest = {
    schema: 'reliable-stage-host-smoke/runtime/v2',
    root,
    omp_binary: binary,
    omp_version: version,
    core_package: corePackage,
    core_version: coreVersion,
    core_tarball_sha256: coreTarballSha256,
    fullstack_package: fullstackPackage,
    fullstack_version: fullstackVersion,
    fullstack_tarball_sha256: fullstackTarballSha256,
    scratch,
  };
  writeJson(join(root, 'runtime-manifest.json'), manifest);
  appendEvidence(evidence, { phase: 'prepare', status: 'PASS', manifest: 'runtime-manifest.json', scratch: Object.fromEntries(CASE_IDS.map(id => [id, relative(root, scratch[id])])), evidence_retained: true });
  process.stdout.write(`${JSON.stringify({ status: 'PREPARED', root, manifest: join(root, 'runtime-manifest.json'), omp_binary: binary })}\n`);
}

function ownedSessionRoots(root: string): string[] {
  const found: string[] = [];
  const scratchRoot = join(root, 'scratch');
  if (!existsSync(scratchRoot)) return found;
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) visit(path);
      else if (entry.isFile() && entry.name === 'session.json' && dir.endsWith(join('.work-state', 'ux-e2e'))) found.push(dirname(dirname(dirname(path))));
    }
  };
  visit(scratchRoot);
  return found;
}

async function cleanup(rootInput: string): Promise<void> {
  const root = resolve(rootInput);
  if (!existsSync(root)) {
    process.stdout.write(`${JSON.stringify({ status: 'CLEAN', root, stopped_sessions: [], evidence_retained: true })}\n`);
    return;
  }
  assertOwnedRoot(root);
  const sessions = ownedSessionRoots(root);
  for (const scratch of sessions) await runStop({ scratchDir: scratch });
  appendEvidence(join(root, 'install-evidence.jsonl'), { phase: 'cleanup', status: 'PASS', stopped_sessions: sessions.map(item => relative(root, item)), evidence_retained: true });
  process.stdout.write(`${JSON.stringify({ status: 'CLEAN', root, stopped_sessions: sessions.map(item => relative(root, item)), evidence_retained: true })}\n`);
}

function usage(): void {
  process.stderr.write('Usage: host-smoke validate | prepare --root <owned-dir> --core <candidate.tgz> --fullstack <candidate.tgz> | cleanup --root <owned-dir>\n');
}

async function main(): Promise<void> {
  const command = process.argv[2];
  try {
    if (command === 'validate') {
      validatePlan();
      process.stdout.write(`${JSON.stringify({ status: 'PLAN_VALID', schema: PLAN.schema, cases: CASE_IDS, attempt_timeout_sec: PLAN.limits.attempt_timeout_sec, max_attempts_per_case: PLAN.limits.max_attempts_per_case })}\n`);
      return;
    }
    if (command === 'prepare') {
      prepare(requiredArg('--root'), requiredArg('--core'), requiredArg('--fullstack'));
      return;
    }
    if (command === 'cleanup') {
      await cleanup(requiredArg('--root'));
      return;
    }
    usage();
    process.exitCode = 2;
  } catch (error) {
    process.stderr.write(`host-smoke: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) void main();
