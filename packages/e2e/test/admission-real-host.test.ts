/**
 * Real-host trusted-pair evidence — workflow-v2 admission wave-003, slice real-host-e2e.
 *
 * <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-admission -->
 *
 * Launches the ACTUAL installed omp binary (identity must resolve under
 * @oh-my-pi/pi-coding-agent) with the OPERATOR-TRUSTED DIAGNOSTIC ordered
 * pair — core position FIRST, provider position SECOND, repeated
 * `--trusted-extension` flags — and records real evidence. This pair is
 * diagnostic allowlist/load-order EVIDENCE ONLY: it issues NO host or
 * policy admission and NO selected-provider activation. Loading a module
 * is not activation and this file never claims otherwise.
 *
 * Evidence recorded:
 *
 *   - `omp --version` output plus the resolved package identity and
 *     provenance (CLI version vs manifest version; either mismatch is a
 *     recorded blocked result BEFORE any probe),
 *   - s1: the ordered REAL source-backed pair
 *     (`--trusted-extension <packages/core/dist/index.js>
 *      --trusted-extension <packages/fullstack/dist/index.js>`). The outcome is
 *     recorded verbatim; a load failure whose observed output matches
 *     extension-load patterns is attributed to the non-factory core dist,
 *     anything else is recorded as a GENERIC launch failure with the exact
 *     host diagnostic retained. Loading is NEVER claimed as activation and
 *     this test never imports either package (no package imports at all),
 *   - rejection of legacy `--extension` combined with `--trusted-extension`
 *     before any durable session effect (CliUsageError),
 *   - rejection of a genuinely configured ambient extension under the pair
 *     (control launch proves the planted location is effective),
 *   - s2/s3: the ordered DIAGNOSTIC pair (core-position + provider-position
 *     probes, test-generated, clearly not a production host claim) proving
 *     the ordered pair: both factories BIND in order (order appended inside
 *     each exported factory — the sequential binding point, never module
 *     import), the registries are read INSIDE the initialized command
 *     handler, ambient stays absent, fresh session ids per launch with
 *     clean non-signaled exits, regular-file report kinds, and NO canonical
 *     command (do-work/team/cto/workflow-provider/init-team) or workflow
 *     tool name (exact seven) may originate from extension loading,
 *   - authority-capability findings from the live runtime: any
 *     authority-like key on pi/ctx is a HARD FAILURE, backing the six
 *     fail-closed blockers (host root, lifecycle identity, inventory
 *     reservation, descriptor-relative filesystem, provider executor,
 *     transport manager) which are initialized BEFORE any skip or
 *     assertion can abort.
 *
 * FULL-SUITE-SAFE CONTRACT (fresh clone)
 *   - Self-contained in-memory fixture: this test NEVER reads or mutates the
 *     committed wave fixture (.work-state/.../real-host-fixture.json).
 *   - Evidence is persisted ONLY to the explicit env path
 *     OMP_ADMISSION_EVIDENCE_PATH; when unset, evidence stays in-process.
 *     A REQUESTED sink that is unwritable records evidence_sink_unwritable
 *     and FAILS the run — never a silent pass.
 *   - node-pty is imported dynamically inside the test: an unavailable
 *     native binding OR an unsupported module shape OR a forkpty/spawn
 *     failure is recorded as a typed blocker and the test skips — never a
 *     top-level failure, never a false proof. Same skip-after-record for an
 *     unresolvable/mismatched host. A skip is NEVER treated as proof.
 *   - The launched host runs fully isolated: HOME, XDG_*, and TMPDIR point
 *     inside the run's scratch; only PATH/TERM are inherited; no ambient
 *     env is forwarded.
 *   - No production mocks, no cwd inference, no extension-order selection,
 *     no generated canonical files, no discoverAgents/FileLock/lstat
 *     substitutes, no package imports.
 *
 * This file owns only itself (plus, when explicitly requested via env, the
 * evidence file); it must not edit e2e server.ts/cli.ts, fullstack, or core
 * sources.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fchmodSync,
  fstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { deferred } from '../src/util.js';
/** Exact slice marker; embedded in evidence and every generated probe module. */
const MARKER =
  '<!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-admission -->';

/** Exact canonical command names owned by the v2 host (packages/core workflow-v2/admission.ts). */
const CANONICAL_COMMANDS: readonly string[] = ['do-work', 'team', 'cto', 'workflow-provider', 'init-team'];
/** The complete exact seven workflow-tool allowlist owned by the v2 host. */
const CANONICAL_WORKFLOW_TOOLS: readonly string[] = [
  'workflow_prepare',
  'workflow_begin',
  'workflow_status',
  'workflow_instructions',
  'workflow_complete',
  'workflow_checkpoint',
  'workflow_advance',
];
const CANONICAL_NAMES: readonly string[] = [...CANONICAL_COMMANDS, ...CANONICAL_WORKFLOW_TOOLS];

/** Keys that would suggest a host authority primitive; a live match is a HARD FAILURE. */
const AUTHORITY_KEY_EXACT: readonly string[] = ['host', 'registry'];
const AUTHORITY_KEY_RE =
  /(resolveroot|resolvesession|activationadmission|trustedroot|canonicalroot|fsauthority|filesystemauthority|lifecycle|inventory|reservation|executor|transportmanager|admission)/i;

function isAuthorityKey(key: string): boolean {
  return AUTHORITY_KEY_EXACT.includes(key.toLowerCase()) || AUTHORITY_KEY_RE.test(key);
}

const HERE = import.meta.dirname as string;
const E2E_PKG_ROOT = resolve(HERE, '..');
const WORKSPACE_ROOT = resolve(E2E_PKG_ROOT, '../..');
/** Real source-backed ordered pair (built dists). Loading them is the HOST's job — never this test's. */
const CORE_ENTRY = join(WORKSPACE_ROOT, 'packages/core/dist/index.js');
const PROVIDER_ENTRY = join(WORKSPACE_ROOT, 'packages/fullstack/dist/index.js');
/** Optional explicit evidence sink; unset = in-process only. */
const EVIDENCE_PATH = process.env.OMP_ADMISSION_EVIDENCE_PATH;
/** Package identity the resolved host binary MUST carry before any probe runs. */
const HOST_PACKAGE = '@oh-my-pi/pi-coding-agent';

/** Observed-output patterns consistent with a non-factory extension load failure. */
const EXTENSION_LOAD_FAILURE_RE =
  /extension factory|not an extension|invalid extension|failed to load|unable to load|error loading|does not provide an export named|is not a function/i;

interface ResolvedHost {
  bin: string;
  realpath: string | null;
  manifestName: string | null;
  manifestVersion: string | null;
}

interface ProbeReport {
  probeId: string;
  writtenAt: string;
  piOwnKeys: string[];
  ctxOwnKeys: string[] | null;
  sessionId: string | null;
  cwd: string | null;
  mode: string | null;
  commandNames: string[] | null;
  toolNames: string[] | null;
  commandNamesError: string | null;
  toolNamesError: string | null;
}

interface LaunchOutcome {
  tag: string;
  argv: string[];
  exitCode: number | null;
  signal: string | null;
  outputTail: string;
  reportTag: string | null;
  durationMs: number;
}

/** Minimal structural type for the node-pty terminal handle used here. */
interface PtyTerm {
  onData(cb: (chunk: string) => void): void;
  onExit(cb: (evt: { exitCode: number | null; signal: number | string | null | undefined }) => void): void;
  write(data: string): void;
  kill(): void;
}
type PtySpawn = (...args: unknown[]) => PtyTerm;

/** Typed failure for a PTY that imports fine but cannot fork/spawn. */
class PtySpawnFailure extends Error {}

/** Resolved inside the test (dynamic import; full-suite-safe when absent). */
let ptySpawn: PtySpawn | null = null;

/**
 * The six fail-closed host-authority blockers. They are seeded into the
 * evidence BEFORE any skip path or assertion so an aborted run still
 * explains exactly why admission remains impossible. Statuses stay
 * 'missing' unless the live host itself proves otherwise — the installed
 * OMP exposes none of these capabilities.
 */
function missingAuthorityBlockers(): Record<string, unknown> {
  return {
    host_issued_root: { status: 'missing', substitute_forbidden: 'ctx.cwd' },
    lifecycle_identity: { status: 'missing', substitute_forbidden: 'session id reuse' },
    actual_inventory_reservation: { status: 'missing', substitute_forbidden: 'discoverAgents(cwd), FileLock' },
    descriptor_relative_filesystem: { status: 'missing', substitute_forbidden: 'lstat/realpath/path joins' },
    provider_executor: { status: 'missing', substitute_forbidden: 'sendUserMessage, exec' },
    transport_manager: { status: 'missing', substitute_forbidden: 'package-level adapters without host authority' },
  };
}

function resolveOmpBinary(): ResolvedHost {
  let bin: string;
  const envBin = process.env.OMP_BIN;
  if (envBin && envBin.length > 0) {
    bin = envBin;
  } else {
    const bunBin = join(homedir(), '.bun', 'bin', 'omp');
    bin = existsSync(bunBin) ? bunBin : 'omp';
  }
  let realpath: string | null = null;
  if (bin !== 'omp') {
    try {
      realpath = realpathSync(bin);
    } catch {
      realpath = null;
    }
  } else {
    const which = spawnSync('which', ['omp'], { encoding: 'utf8' });
    if (which.status === 0 && typeof which.stdout === 'string') {
      const found = which.stdout.trim();
      if (found.length > 0) {
        bin = found;
        try {
          realpath = realpathSync(found);
        } catch {
          realpath = null;
        }
      }
    }
  }
  let manifestName: string | null = null;
  let manifestVersion: string | null = null;
  if (realpath) {
    let dir = dirname(realpath);
    for (let i = 0; i < 6; i++) {
      const pkgPath = join(dir, 'package.json');
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
            name?: string;
            version?: string;
          };
          if (pkg.name === HOST_PACKAGE) {
            manifestName = pkg.name ?? null;
            manifestVersion = pkg.version ?? null;
            break;
          }
        } catch {
          /* keep walking */
        }
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  }
  return { bin, realpath, manifestName, manifestVersion };
}

function ompVersion(bin: string, env: Record<string, string>): { ok: boolean; output: string } {
  const res = spawnSync(bin, ['--version'], {
    encoding: 'utf8',
    timeout: 30_000,
    // The candidate binary is probed under the SAME minimal scratch env it
    // will be launched with — ambient NODE_OPTIONS/preload must never
    // execute before the identity/provenance gate issues its verdict.
    env,
  });
  const output = `${res.stdout ?? ''}${res.stderr ?? ''}`.trim();
  return { ok: res.status === 0 && output.length > 0, output };
}

/** First semver-ish token in free version output, for provenance comparison. */
function firstVersionToken(output: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[-+][^\s]*)?)/u.exec(output);
  return m !== null ? (m[1] ?? null) : null;
}

function stripAnsi(s: string): string {
  // biome-ignore lint: evidence sanitizer, no control chars needed beyond ESC runs
  return s.replace(/\x1B\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '');
}

const PROBE_ID = `probe-${Date.now().toString(36)}`;

/**
 * PROVIDER-position diagnostic probe (second --trusted-extension entry).
 * The order marker is appended INSIDE the exported factory — the sequential
 * binding point the OMP loader drives — never at module top level (module
 * evaluation order is concurrent and proves nothing). The registries are
 * queried INSIDE the initialized command handler: during binding the
 * runtime throws ExtensionRuntimeNotInitializedError. Never a provider
 * stand-in for production claims.
 */
function providerProbeModuleSource(reportDir: string, orderLogPath: string): string {
  const reportPathEsc = JSON.stringify(join(reportDir, 'probe-report'));
  const orderLogEsc = JSON.stringify(orderLogPath);
  return `// ${MARKER}
// Diagnostic observer ONLY (provider position). Registers non-canonical names;
// never a provider stand-in for production claims. Order marker + registry
// queries happen at their honest points (factory binding / initialized handler).
import { writeFileSync, mkdirSync, appendFileSync } from 'node:fs';
const REPORT_BASE = ${reportPathEsc};
const PROBE_ID = ${JSON.stringify(PROBE_ID)};
const safe = (fn) => { try { return fn(); } catch (e) { return null; } };
export default function admissionProbe(pi) {
  appendFileSync(${orderLogEsc}, 'provider\\n');
  const piOwnKeys = Object.keys(pi);
  pi.registerCommand('admission-probe-report', {
    description: 'diagnostic observer: write trusted-pair evidence report (non-canonical)',
    handler: async (args, ctx) => {
      const tag = String(args ?? '').trim().split(/\\s+/)[0] || 'run';
      let commandNames = null, commandNamesError = null;
      let toolNames = null, toolNamesError = null;
      try {
        commandNames = (pi.getCommands() ?? []).map((c) => (typeof c === 'string' ? c : c.name));
      } catch (e) { commandNamesError = String(e && e.message ? e.message : e); }
      try {
        toolNames = (pi.getAllTools() ?? []).map((t) => (typeof t === 'string' ? t : t.name));
      } catch (e) { toolNamesError = String(e && e.message ? e.message : e); }
      const report = {
        probeId: PROBE_ID,
        writtenAt: new Date().toISOString(),
        piOwnKeys,
        ctxOwnKeys: ctx ? Object.keys(ctx) : null,
        sessionId: ctx && ctx.sessionManager ? safe(() => ctx.sessionManager.getSessionId()) : null,
        cwd: ctx ? (ctx.cwd ?? null) : null,
        mode: ctx ? (ctx.mode ?? null) : null,
        commandNames, toolNames, commandNamesError, toolNamesError,
      };
      mkdirSync(REPORT_BASE, { recursive: true });
      writeFileSync(REPORT_BASE + '-' + tag + '.json', JSON.stringify(report, null, 2));
      return 'trusted-pair probe report written: ' + tag;
    },
  });
}
`;
}

/**
 * CORE-position diagnostic evidence probe (first --trusted-extension entry).
 * The order marker is appended INSIDE the exported factory. Clearly NOT a
 * production host: the real provider-neutral core host is a host-authority
 * component the installed OMP does not issue (see blockers); this probe only
 * proves ordered allowlist loading.
 */
function coreProbeModuleSource(orderLogPath: string): string {
  const orderLogEsc = JSON.stringify(orderLogPath);
  return `// ${MARKER}
// Diagnostic CORE-POSITION evidence probe. NOT a production host claim.
// Order marker appended INSIDE the factory (sequential binding point).
import { appendFileSync } from 'node:fs';
export default function admissionCoreProbe(pi) {
  appendFileSync(${orderLogEsc}, 'core\\n');
  try {
    pi.registerCommand('admission-core-probe', {
      description: 'diagnostic core-position probe (non-canonical; NOT a production host claim)',
      handler: async () => 'core probe present',
    });
  } catch {}
}
`;
}

function ambientModuleSource(markerPath: string): string {
  return `// ${MARKER}
// Ambient discovery probe: writes a marker when actually loaded by the host.
import { writeFileSync, mkdirSync } from 'node:fs';
const MARKER = ${JSON.stringify(markerPath)};
export default function admissionAmbientProbe(pi) {
  mkdirSync(MARKER.slice(0, MARKER.lastIndexOf('/')), { recursive: true });
  writeFileSync(MARKER, JSON.stringify({ loadedAt: new Date().toISOString(), pid: process.pid }, null, 2));
  try {
    pi.registerCommand('admission-ambient-probe', { description: 'ambient discovery marker (non-canonical)', handler: async () => 'ambient probe present' });
  } catch {}
}
`;
}

/**
 * Child env for the launched host: built FROM the scratch, not filtered
 * from the operator env. HOME, XDG_*, and TMPDIR point inside the scratch
 * so profile/config/cache/sessions are fully isolated; only PATH and TERM
 * are inherited; no ambient environment (and therefore no loader/preload
 * injection) is forwarded at all.
 */
function diagnosticChildEnv(scratch: string): Record<string, string> {
  const home = join(scratch, 'home');
  return {
    PATH: process.env['PATH'] ?? '/usr/bin:/bin',
    HOME: home,
    TMPDIR: join(scratch, 'tmp'),
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
    TERM: 'xterm-256color',
  };
}

/** Canonical realpath + regular-file kind check, or null when absent/wrong-kind. */
function canonicalRegularFile(path: string): string | null {
  try {
    const canonical = realpathSync.native(path);
    return statSync(canonical).isFile() ? canonical : null;
  } catch {
    return null;
  }
}

async function launchOmp(opts: {
  bin: string;
  scratch: string;
  args: string[];
  tag: string;
  commandToSend?: string | null;
  reportTag?: string | null;
  settleMs?: number;
  readyTimeoutMs?: number;
}): Promise<LaunchOutcome> {
  if (ptySpawn === null) throw new PtySpawnFailure('node-pty unavailable');
  const settleMs = opts.settleMs ?? 1200;
  const readyTimeoutMs = opts.readyTimeoutMs ?? 30_000;
  const started = Date.now();
  let term: PtyTerm | null = null;
  // A native binding can import successfully yet reject forkpty/process
  // creation — that is a recorded blocker + skip, never a suite abort.
  try {
    term = ptySpawn(opts.bin, opts.args, {
      name: 'xterm-256color',
      cols: 100,
      rows: 30,
      cwd: opts.scratch,
      env: diagnosticChildEnv(opts.scratch),
    });
  } catch (err) {
    throw new PtySpawnFailure(err instanceof Error ? err.message : String(err));
  }
  let output = '';
  let exiting = false;
  // Attach the data listener IMMEDIATELY after spawn: readiness polling,
  // report waits, and evidence outputTail all depend on captured bytes.
  term.onData((chunk: string) => {
    output += chunk;
  });
  // Real external process on a real PTY: deterministic/fake time control
  // cannot drive an external binary, so platform-clock polling is required.
  // Node 20 has no Promise.withResolvers; the package's own deferred
  // helper is the existing Node-20-compatible holder for this shape.
  const exitDone = deferred<{ exitCode: number | null; signal: string | null }>();
  term.onExit(({ exitCode, signal }: { exitCode: number | null; signal: number | string | null | undefined }) => {
    exiting = true;
    exitDone.resolve({ exitCode, signal: signal == null ? null : String(signal) });
  });

  // Wait for UI readiness: output started and settled (no new bytes for settleMs).
  const readyDeadline = Date.now() + readyTimeoutMs;
  let lastLen = -1;
  let lastChange = Date.now();
  while (Date.now() < readyDeadline) {
    if (exiting) break;
    if (output.length !== lastLen) {
      lastLen = output.length;
      lastChange = Date.now();
    } else if (output.length > 0 && Date.now() - lastChange >= settleMs) {
      break;
    }
    await new Promise((r) => setTimeout(r, 150));
  }

  let reportTag: string | null = null;
  if (opts.commandToSend && !exiting) {
    term.write(`${opts.commandToSend}\r`);
    if (opts.reportTag) {
      const reportPath = join(
        opts.scratch,
        'probe-report',
        `probe-report-${opts.reportTag}.json`,
      );
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline && !existsSync(reportPath)) {
        if (exiting) break;
        await new Promise((r) => setTimeout(r, 150));
      }
      reportTag = existsSync(reportPath) ? opts.reportTag : null;
    }
  }

  // Graceful quit: Ctrl+C twice, then fall back to kill.
  if (!exiting) {
    term.write('\x03');
    await new Promise((r) => setTimeout(r, 400));
  }
  if (!exiting) {
    term.write('\x03');
    const gracefulDeadline = Date.now() + 10_000;
    while (Date.now() < gracefulDeadline && !exiting) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  if (!exiting) {
    try {
      term.kill();
    } catch {
      /* already gone */
    }
  }
  const exit = await exitDone.promise;
  return {
    tag: opts.tag,
    argv: opts.args,
    exitCode: exit.exitCode,
    signal: exit.signal,
    outputTail: stripAnsi(output).slice(-4000),
    reportTag,
    durationMs: Date.now() - started,
  };
}

function canonicalViolations(report: ProbeReport): string[] {
  const names = [
    ...(report.commandNames ?? []),
    ...(report.toolNames ?? []),
  ];
  // EXACT canonical sets only (5 commands + 7 workflow tools) — never a
  // prefix filter, which unrelated names could evade.
  return names.filter((n) => CANONICAL_NAMES.includes(n));
}

function authorityKeyCandidates(report: ProbeReport): string[] {
  const keys = [...(report.piOwnKeys ?? []), ...(report.ctxOwnKeys ?? [])];
  return keys.filter((k) => isAuthorityKey(k));
}

/** Durable evidence shape; blockers/launches stay precisely indexed for the fail-closed paths. */
interface EvidenceRecord {
  marker: string;
  fixture_source: string;
  evidence_sink: string | null;
  scratch: string;
  skipped: string | null;
  host: unknown;
  ordered_real_pair: unknown;
  trusted_pair_proof: unknown;
  diagnostic_probe_pair?: unknown;
  launches: Record<string, LaunchOutcome>;
  capability_findings: unknown;
  blockers: Record<string, unknown>;
  activated: boolean;
  activation_claim: string;
  concluded_at: string | null;
}

test('real-host trusted-pair evidence: ordered diagnostic pair, rejections, restart, fail-closed blockers', async (t) => {
  // Fresh-clone isolation: the ENTIRE scenario (probes, ambient module,
  // isolated HOME, sessions, reports) lives in this temp scratch and is
  // removed when the test ends — pass, fail, or skip.
  const scratch = await mkdtemp(join(tmpdir(), 'admission-realhost-'));
  t.after(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  const evidence: EvidenceRecord = {

    marker: MARKER,
    fixture_source: 'in-memory (self-contained); the committed real-host-fixture.json is never read or written by this test',
    evidence_sink: EVIDENCE_PATH ?? null,
    scratch,
    skipped: null as string | null,
    host: null as unknown,
    ordered_real_pair: null as unknown,
    trusted_pair_proof: null as unknown,
    launches: {} as Record<string, LaunchOutcome>,
    capability_findings: null as unknown,
    // Six fail-closed blockers seeded BEFORE any skip path or assertion.
    blockers: missingAuthorityBlockers(),
    activated: false,
    activation_claim:
      'none — the operator-trusted pair is diagnostic load-order evidence only; it issues NO host/policy admission and NO selected-provider activation',
    concluded_at: null as string | null,
  };
  let sinkBroken = false;
  // Requested external evidence sink, hardened to the SAME no-follow
  // discipline as the server's evidence sinks (security ADMISSION-005):
  // O_NOFOLLOW leaf (a planted symlink is rejected with ELOOP, not
  // followed), 0600 creation, descriptor fchmod, regular-file fstat.
  // Parent-dir creation stays plain mkdir — symlinked components higher
  // up are infeasible to reject on standard temp chains and are covered
  // by the documented residual, not claimed away.
  const writeEvidenceFile = (path: string, body: string): void => {
    const noFollow = fsConstants.O_NOFOLLOW ?? 0;
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | noFollow, 0o600);
    try {
      try {
        fchmodSync(fd, 0o600);
      } catch {
        /* platform may not support chmod */
      }
      if (!fstatSync(fd).isFile()) {
        throw new Error(`evidence sink must be a regular file: ${path}`);
      }
      writeFileSync(fd, body);
    } finally {
      closeSync(fd);
    }
  };
  const persist = (): boolean => {
    evidence.concluded_at = new Date().toISOString();
    if (EVIDENCE_PATH === undefined || EVIDENCE_PATH.length === 0) return true;
    try {
      mkdirSync(dirname(EVIDENCE_PATH), { recursive: true });
      writeEvidenceFile(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
      return true;
    } catch (err) {
      sinkBroken = true;
      evidence.blockers['evidence_sink_unwritable'] = {
        detail:
          'The requested OMP_ADMISSION_EVIDENCE_PATH is unwritable — a required evidence run cannot be verified, so this run is invalid (never a silent pass or skip).',
        path: EVIDENCE_PATH,
        error: String(err),
      };
      process.stderr.write(`admission-real-host: failed to persist evidence to ${EVIDENCE_PATH}: ${String(err)}\n`);
      return false;
    }
  };
  const persistOrFail = (why: string): void => {
    if (!persist() || sinkBroken) {
      assert.fail(`required evidence sink unwritable (${String(EVIDENCE_PATH)}): ${why}`);
    }
  };
  t.after(persist);

  // ------------------------------------------------------------- node-pty
  // Dynamic import: a missing native binding must never fail the suite at
  // module load. Record the blocker, then skip — local evidence first.
  // An unsupported module shape is recorded too (never a bare skip).
  try {
    const mod: unknown = await import('node-pty');
    // Runtime narrowing on the untyped native boundary: probe both the
    // CJS surface (`mod.spawn`) and the ESM default surface
    // (`mod.default.spawn`) with `in` guards — no fabricated shapes.
    let candidate: unknown;
    if (typeof mod === 'object' && mod !== null && 'spawn' in mod) {
      candidate = mod.spawn;
    } else if (
      typeof mod === 'object' &&
      mod !== null &&
      'default' in mod &&
      typeof mod.default === 'object' &&
      mod.default !== null &&
      'spawn' in mod.default
    ) {
      candidate = mod.default.spawn;
    }
    if (typeof candidate === 'function') {
      // node-pty is an untyped native boundary; the structural PtySpawn type
      // documents the exact surface this test uses.
      ptySpawn = candidate as unknown as PtySpawn;
    } else {
      evidence.blockers['node_pty_unavailable'] = {
        detail:
          'node-pty dynamic import succeeded but exposed no callable spawn/default.spawn — unsupported module shape; real PTY launches impossible.',
        shape: typeof mod === 'object' && mod !== null ? Object.keys(mod) : [typeof mod],
      };
    }
  } catch (err) {
    evidence.blockers['node_pty_unavailable'] = {
      detail: 'node-pty native binding unavailable; real PTY launches impossible in this environment.',
      error: String(err),
    };
  }
  if (ptySpawn === null) {
    evidence.skipped = 'node_pty_unavailable — real-host PTY launches impossible; local evidence recorded. A skip is NOT proof.';
    persistOrFail('node-pty unavailable skip');
    t.skip('node-pty unavailable — real-host PTY launches impossible; local evidence recorded');
    return;
  }

  // PTY spawn wrapper: a forkpty/process-creation failure AFTER a
  // successful import is a recorded blocker + skip, never an abort.
  const launchRecorded = async (opts: {
    bin: string;
    scratch: string;
    args: string[];
    tag: string;
    commandToSend?: string | null;
    reportTag?: string | null;
    settleMs?: number;
    readyTimeoutMs?: number;
  }): Promise<LaunchOutcome> => {
    try {
      return await launchOmp(opts);
    } catch (err) {
      if (err instanceof PtySpawnFailure) {
        evidence.blockers['node_pty_unavailable'] = {
          detail: 'PTY creation failed after a successful node-pty import (forkpty/process spawn failure); real launches impossible.',
          error: err.message,
        };
        evidence.skipped = 'node_pty_unavailable (spawn failure) — recorded blocker; a skip is NOT proof.';
        persistOrFail('pty spawn failure');
        t.skip(`pty spawn failure: ${err.message}`);
      }
      throw err;
    }
  };

  try {
    // Isolated runtime dirs for the launched host (before any launch).
    const homeDir = join(scratch, 'home');
    for (const dir of [
      homeDir,
      join(homeDir, '.config'),
      join(homeDir, '.cache'),
      join(homeDir, '.local', 'share'),
      join(homeDir, '.local', 'state'),
      join(scratch, 'tmp'),
    ]) {
      mkdirSync(dir, { recursive: true });
    }

    // ------------------------------------------------------------------ host
    // Identity + provenance gate: anything that does not resolve under
    // @oh-my-pi/pi-coding-agent (or whose versions disagree) is a recorded
    // BLOCKED result before any probe can attribute evidence to OMP.
    const host = resolveOmpBinary();
    // Isolated runtime dirs already exist; the probe runs under the same
    // minimal scratch env the PTY launches use.
    const version = ompVersion(host.bin, diagnosticChildEnv(scratch));
    const cliVersion = firstVersionToken(version.output);
    const provenanceMatch =
      host.manifestVersion !== null && cliVersion !== null && host.manifestVersion === cliVersion;
    evidence.host = {
      bin: host.bin,
      realpath: host.realpath,
      manifest_name: host.manifestName,
      manifest_version: host.manifestVersion,
      cli_version_output: version.output,
      cli_version: cliVersion,
      required_package: HOST_PACKAGE,
      identity_verified: host.manifestName === HOST_PACKAGE,
      provenance_match: provenanceMatch,
    };
    if (!version.ok) {
      evidence.blockers['unavailable_host'] = {
        status: 'blocked',
        detail: 'Active omp binary unresolvable or `--version` failed; real-host launch impossible.',
        bin: host.bin,
        output: version.output,
      };
      evidence.skipped = 'unavailable_host — recorded blocked result; a skip is NOT proof.';
      persistOrFail('unavailable host skip');
      t.skip(`unavailable host: ${host.bin}: ${version.output}`);
      return;
    }
    if (host.manifestName !== HOST_PACKAGE) {
      evidence.blockers['host_authority_mismatch'] = {
        status: 'blocked',
        detail: `The resolved omp binary does not resolve under ${HOST_PACKAGE}; a wrapper/mock/unrelated executable can never produce OMP evidence. Recorded blocked result before any probe.`,
        bin: host.bin,
        realpath: host.realpath,
        manifest_name: host.manifestName,
      };
      evidence.skipped = 'host_authority_mismatch — recorded blocked result; a skip is NOT proof.';
      persistOrFail('host authority mismatch');
      t.skip(`unrelated host: ${host.bin} does not resolve under ${HOST_PACKAGE}`);
      return;
    }
    if (!provenanceMatch) {
      evidence.blockers['host_provenance_mismatch'] = {
        status: 'blocked',
        detail:
          'CLI --version output and the resolved package manifest version disagree; capability conclusions could describe a different OMP source than the launched process. Recorded blocked result before any probe.',
        cli_version: cliVersion,
        manifest_version: host.manifestVersion,
      };
      evidence.skipped = 'host_provenance_mismatch — recorded blocked result; a skip is NOT proof.';
      persistOrFail('host provenance mismatch');
      t.skip(`host provenance mismatch: cli=${String(cliVersion)} manifest=${String(host.manifestVersion)}`);
      return;
    }

    // Shared fixtures in the scratch project.
    const probeDir = join(scratch, 'probe');
    const ambientDir = join(scratch, 'ambient');
    mkdirSync(probeDir, { recursive: true });
    mkdirSync(ambientDir, { recursive: true });
    const coreProbePath = join(probeDir, 'admission-core-probe.mjs');
    const providerProbePath = join(probeDir, 'admission-probe.mjs');
    const ambientPath = join(ambientDir, 'admission-ambient.mjs');
    const ambientMarker = join(ambientDir, 'loaded.json');
    const orderLogPath = join(probeDir, 'order.log');
    writeFileSync(coreProbePath, coreProbeModuleSource(orderLogPath));
    writeFileSync(providerProbePath, providerProbeModuleSource(join(scratch, 'probe-report'), orderLogPath));
    writeFileSync(ambientPath, ambientModuleSource(ambientMarker));
    const overlayPath = join(scratch, 'overlay.json');
    writeFileSync(
      overlayPath,
      JSON.stringify({ extensions: [ambientPath] }, null, 2),
    );
    evidence.diagnostic_probe_pair = {
      purpose: 'ordered-pair proof + capability findings',
      not_a_production_host_claim: true,
      core_position: coreProbePath,
      provider_position: providerProbePath,
      order_log: orderLogPath,
      order_marker_point: 'inside each exported factory (sequential binding point), never module top level',
      registry_query_point: 'inside the initialized command handler (runtime is uninitialized during binding)',
      expected_bind_order: ['core', 'provider'],
    };

    const baseArgs = (sessionDir: string): string[] => [
      '--config',
      overlayPath,
      '--session-dir',
      sessionDir,
      '--approval-mode',
      'yolo',
      '--max-time',
      '30m',
    ];
    // ------------------------------------------ ordered REAL pair (s1)
    // Source-backed pair: built dists. Loading them is the HOST's job — this
    // test never imports either package and never claims activation. Both
    // entries must be real regular files BEFORE launch (statSync kind, not
    // mere existence).
    const realPairEntries = ([
      ['core', CORE_ENTRY],
      ['provider', PROVIDER_ENTRY],
    ] as const).map(([role, path]) => {
      const canonical = canonicalRegularFile(path);
      return { role, path, canonical, present: canonical !== null };
    });
    // The s1 argv carries the CANONICAL realpaths (same discipline as the
    // launcher's pre-spawn boundary); requested lexical paths stay recorded.
    const s1PairPaths = realPairEntries.map(e => e.canonical ?? e.path);
    evidence.ordered_real_pair = {
      purpose: 'host-loading diagnostic ONLY — not admission, not selected-provider activation',
      mode: 'trusted-module',
      entries: realPairEntries,
      argv_flags: ['--trusted-extension', s1PairPaths[0], '--trusted-extension', s1PairPaths[1]],
      argv_uses_canonical: true,
      order: 'core position FIRST, provider position second',
      loading_is_not_activation: true,
      package_import_by_test: 'forbidden — the real host performs all loading',
    };
    const missingPairRoles = realPairEntries.filter(e => !e.present).map(e => e.role);
    if (missingPairRoles.length > 0) {
      // Exact missing/wrong-kind record: never substitute, never activate.
      evidence.blockers['ordered_pair_missing'] = {
        status: 'blocked',
        detail:
          'Real source-backed ordered pair incomplete (missing or non-regular-file entries); the s1 ordered real-pair launch cannot run. Recorded exactly; no substitute, no activation claim.',
        missing_roles: missingPairRoles,
        entries: realPairEntries,
      };
    } else {
      const s1 = await launchRecorded({
        bin: host.bin,
        scratch,
        args: [
          '--trusted-extension',
          s1PairPaths[0],
          '--trusted-extension',
          s1PairPaths[1],
          ...baseArgs(join(scratch, 'sessions-s1')),
        ],
        tag: 's1-ordered-real-pair',
        readyTimeoutMs: 20_000,
        settleMs: 800,
      });
      evidence.launches['s1_ordered_real_pair'] = s1;
      if (s1.exitCode !== 0 || s1.signal !== null) {
        // Attribute the blocker ONLY from the observed host output: a
        // config/model/dependency failure follows a different branch and is
        // reported as a generic launch failure with the exact diagnostic.
        const matchesFactoryFailure = EXTENSION_LOAD_FAILURE_RE.test(s1.outputTail);
        evidence.blockers['core_extension_activation'] = matchesFactoryFailure
          ? {
              status: 'blocked',
              kind: 'extension_load_failure',
              detail:
                'Ordered real pair trusted launch failed at host load: observed output matches extension-load failure patterns (the core dist entry is not itself an OMP extension factory; activation requires host-issued options the installed OMP never supplies). Loading is NOT activation and this test never imports the packages.',
              exitCode: s1.exitCode,
              signal: s1.signal,
              observed_output: s1.outputTail.slice(-1200),
            }
          : {
              status: 'blocked',
              kind: 'generic_launch_failure',
              detail:
                'Ordered real-pair trusted launch failed for an observed reason NOT attributable to core activation (possible config/model/dependency error). Generic launch failure recorded; the exact host diagnostic is retained verbatim; no core-activation attribution.',
              exitCode: s1.exitCode,
              signal: s1.signal,
              observed_output: s1.outputTail.slice(-1200),
            };
      } else {
        evidence.blockers['core_extension_activation'] = {
          status: 'blocked',
          kind: 'loading_evidence_only',
          detail:
            'Trusted launch of the real ordered pair returned cleanly, but this is loading evidence ONLY: the admission prerequisites (host-issued root, lifecycle identity, inventory reservation, descriptor-relative filesystem, provider executor, transport manager) remain absent. No activation claim.',
          exitCode: s1.exitCode,
        };
      }
    }

    // ------------------------------------------------- r1: legacy flag mixing
    const r1SessionDir = join(scratch, 'sessions-r1');
    const r1 = await launchRecorded({
      bin: host.bin,
      scratch,
      args: [
        '--trusted-extension',
        coreProbePath,
        '--extension',
        ambientPath,
        ...baseArgs(r1SessionDir),
      ],
      tag: 'r1-flag-mix-rejection',
      readyTimeoutMs: 20_000,
      settleMs: 800,
    });
    evidence.launches['r1_flag_mix_rejection'] = r1;
    assert.equal(
      r1.exitCode !== 0 || r1.signal !== null,
      true,
      `flag mixing must be rejected (non-zero exit), got exit=${r1.exitCode}`,
    );
    assert.match(
      r1.outputTail,
      /trusted-extension/i,
      'rejection output must name the offending flag',
    );
    assert.equal(
      existsSync(r1SessionDir),
      false,
      'rejected argv must leave no durable session effects',
    );

    // ---------------------------------------------- c1: ambient control launch
    // No pair flags: discovery stays enabled, so the overlay-configured
    // ambient extension MUST load. This proves the planted location is
    // effective; without this control, ambient rejection evidence is vacuous.
    rmSync(ambientMarker, { force: true });
    const c1 = await launchRecorded({
      bin: host.bin,
      scratch,
      args: baseArgs(join(scratch, 'sessions-c1')),
      tag: 'c1-ambient-control',
    });
    evidence.launches['c1_ambient_control'] = c1;
    assert.equal(
      existsSync(ambientMarker),
      true,
      'ambient control launch must load the overlay-configured extension (planted location ineffective otherwise)',
    );

    // --------------------------------- s2: ordered DIAGNOSTIC pair launch
    // Ordered diagnostic pair: core-position probe FIRST, provider-position
    // probe SECOND. Ambient discovery must stay off; the factory-bound order
    // log must read ['core','provider'] (the sequential BINDING point —
    // module import order is concurrent and proves nothing).
    rmSync(ambientMarker, { force: true });
    rmSync(orderLogPath, { force: true });
    const s2 = await launchRecorded({
      bin: host.bin,
      scratch,
      args: [
        '--trusted-extension',
        coreProbePath,
        '--trusted-extension',
        providerProbePath,
        ...baseArgs(join(scratch, 'sessions-s2')),
      ],
      tag: 's2-ordered-diagnostic-pair',
      commandToSend: '/admission-probe-report s2',
      reportTag: 's2',
    });
    evidence.launches['s2_ordered_diagnostic_pair'] = s2;
    // A healthy diagnostic launch ends cleanly and non-signaled.
    assert.equal(
      s2.exitCode,
      0,
      `ordered diagnostic launch must exit cleanly, exit=${String(s2.exitCode)}: ${s2.outputTail.slice(-600)}`,
    );
    assert.equal(s2.signal, null, `a healthy diagnostic launch must not be signaled, signal=${String(s2.signal)}`);
    assert.notEqual(
      s2.reportTag,
      null,
      'probe command must produce a report from the real host',
    );
    const report2Path = join(scratch, 'probe-report', 'probe-report-s2.json');
    assert.ok(statSync(report2Path).isFile(), 'probe report must exist as a REGULAR file');
    assert.equal(
      existsSync(ambientMarker),
      false,
      'ambient extension must NOT load under the trusted pair (disableExtensionDiscovery)',
    );
    assert.ok(statSync(orderLogPath).isFile(), 'factory-bound order log must exist as a REGULAR file');
    const importOrder = readFileSync(orderLogPath, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
    evidence.trusted_pair_proof = {
      argv: ['--trusted-extension', coreProbePath, '--trusted-extension', providerProbePath],
      factory_bind_order: importOrder,
      expected: ['core', 'provider'],
      note:
        'each probe appends its role INSIDE its exported factory (the sequential binding point); the log proves the host bound the trusted pair in supplied order — core position FIRST, provider second',
    };
    assert.deepEqual(
      importOrder,
      ['core', 'provider'],
      'trusted pair must BIND entries in supplied order — core position FIRST, provider second',
    );
    const report2 = JSON.parse(readFileSync(report2Path, 'utf8')) as ProbeReport;
    // Registry names were captured INSIDE the initialized handler; both
    // ordered probe entries must be registered by the real host.
    const probeCommands = (report2.commandNames ?? [])
      .filter((n) => n === 'admission-core-probe' || n === 'admission-probe-report')
      .sort();
    assert.deepEqual(
      probeCommands,
      ['admission-core-probe', 'admission-probe-report'],
      'both ordered probe entries must be registered by the real host (core position AND provider position)',
    );
    // The initialized-handler registry queries must have SUCCEEDED for
    // both surfaces — a silently failed query can never stand behind the
    // exact canonical-set claims below.
    assert.equal(
      report2.commandNamesError,
      null,
      `initialized getCommands query must succeed, got: ${String(report2.commandNamesError)}`,
    );
    assert.equal(
      report2.toolNamesError,
      null,
      `initialized getAllTools query must succeed, got: ${String(report2.toolNamesError)}`,
    );

    // ------------------------------------------------- s3: lifecycle restart
    const s3 = await launchRecorded({
      bin: host.bin,
      scratch,
      args: [
        '--trusted-extension',
        coreProbePath,
        '--trusted-extension',
        providerProbePath,
        ...baseArgs(join(scratch, 'sessions-s3')),
      ],
      tag: 's3-restart',
      commandToSend: '/admission-probe-report s3',
      reportTag: 's3',
    });
    evidence.launches['s3_restart'] = s3;
    // Restart evidence requires a CLEAN, non-signaled outcome too: a
    // process that writes the report then crashes is not lifecycle proof.
    assert.equal(
      s3.exitCode,
      0,
      `restart launch must exit cleanly, exit=${String(s3.exitCode)}: ${s3.outputTail.slice(-600)}`,
    );
    assert.equal(s3.signal, null, `a healthy restart must not be signaled, signal=${String(s3.signal)}`);
    assert.notEqual(s3.reportTag, null, 'restart probe report must be written');
    const report3Path = join(scratch, 'probe-report', 'probe-report-s3.json');
    assert.ok(statSync(report3Path).isFile(), 'restart probe report must exist as a REGULAR file');
    const report3 = JSON.parse(readFileSync(report3Path, 'utf8')) as ProbeReport;
    assert.equal(
      report3.commandNamesError,
      null,
      `initialized getCommands query must succeed on restart, got: ${String(report3.commandNamesError)}`,
    );
    assert.equal(
      report3.toolNamesError,
      null,
      `initialized getAllTools query must succeed on restart, got: ${String(report3.toolNamesError)}`,
    );

    // --------------------------------------------------- capability findings
    const authority2 = authorityKeyCandidates(report2);
    const authority3 = authorityKeyCandidates(report3);
    const findings = {
      s2: {
        piOwnKeys: report2.piOwnKeys,
        ctxOwnKeys: report2.ctxOwnKeys,
        authorityKeyCandidates: authority2,
        sessionId: report2.sessionId,
        commandNames: report2.commandNames,
        toolNames: report2.toolNames,
        commandNamesError: report2.commandNamesError,
        toolNamesError: report2.toolNamesError,
      },
      s3: {
        sessionId: report3.sessionId,
        authorityKeyCandidates: authority3,
      },
      restartSessionIdsDistinct: null as boolean | null,
    };
    findings.restartSessionIdsDistinct =
      report2.sessionId != null &&
      report3.sessionId != null &&
      report2.sessionId !== report3.sessionId;
    evidence.capability_findings = findings;

    // ------------------------------------------------------- hard assertions
    // A live host exposing an authority-like surface fails LOUDLY here —
    // silently recording six missing prerequisites would mask a new
    // activation path.
    assert.deepEqual(
      authority2,
      [],
      `live host must not expose authority-like capabilities on pi/ctx (s2); found: ${authority2.join(', ')}`,
    );
    assert.deepEqual(
      authority3,
      [],
      `live host must not expose authority-like capabilities on pi/ctx (s3); found: ${authority3.join(', ')}`,
    );
    assert.equal(
      findings.restartSessionIdsDistinct,
      true,
      `restart must observe a fresh session id (s2=${String(report2.sessionId)} s3=${String(report3.sessionId)})`,
    );
    assert.notEqual(
      report2.sessionId,
      null,
      'session identity must be observable via the real host',
    );
    const violations = [...canonicalViolations(report2), ...canonicalViolations(report3)];
    assert.deepEqual(
      violations,
      [],
      `canonical command/tool names (exact 5 commands + 7 workflow tools) must never originate from extension loading; found: ${violations.join(', ')}`,
    );
    assert.equal(
      (report2.commandNames ?? []).includes('admission-ambient-probe'),
      false,
      'ambient command must be absent from the allowlisted host registry',
    );

    // Refine the two blockers whose evidence the run sharpened (all six
    // were seeded before any skip/assert path could abort).
    evidence.blockers['lifecycle_identity'] = {
      status: 'missing',
      evidence: 'no lifecycle token beside sessionId in either restart report',
      substitute_forbidden: 'session id reuse',
      observed_session_ids: [report2.sessionId, report3.sessionId],
    };
    evidence.blockers['host_issued_root'] = {
      status: 'missing',
      substitute_forbidden: 'ctx.cwd',
      authority_key_candidates: authority2,
    };
  } finally {
    persistOrFail('end of run');
  }
});
