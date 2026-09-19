/**
 * UX E2E test server — localhost HTTP+WS bridge to a real omp PTY session.
 *
 * Hosts one HTTP+WS server on a loopback address with an ephemeral port,
 * serves a browser page (xterm) that talks to a single PTY running omp
 * with the omp-workflows plugin, and appends every PTY output frame to a
 * server-side `transcript.jsonl` — the evidence backbone for the report.
 *
 * Security posture (ported from @pi-harness/web-terminal, MIT):
 *   - browser access uses a one-shot, 60-second bootstrap code exchanged for
 *     an HttpOnly session cookie; the internal bearer remains programmatic;
 *   - Origin header (when present) must match the server's own origin,
 *     Host header must match exactly;
 *   - X-Frame-Options: DENY, Referrer-Policy: no-referrer, strict CSP;
 *   - per-connection rate limiter caps inbound messages per rolling window;
 *   - idle timer closes the session after no inbound traffic;
 *   - graceful PTY shutdown waits for the original PTY exit; no PID escalation;
 *   - 64 KiB max inbound WS frame; no file API exposed.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, symlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { IPty } from 'node-pty';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket as WS } from 'ws';

import { deferred } from './util.js';
import type {
  ScenarioSelectors,
  ScenarioWorkspacePaths,
  ScenarioTranscriptExpectations,
} from './scenario.js';
import { stripAnsi } from './driver.js';
import { inspectRuntimePluginRegistry, runtimeExtensionPackagePath, type RuntimePluginRegistry } from './runtime.js';
import { writeUxE2eOverlay } from './overlay.js';
/** Max inbound WS frame size (defense-in-depth; the browser never needs more). */
export const MAX_INBOUND_WS_BYTES = 64 * 1024;
import {
  appendPinnedFile,
  closePinnedDirectory,
  MAX_PINNED_READ_BYTES,
  pinDirectory,
  pinOrCreateDirectory,
  processStartIdentity,
  readPinnedFileFull,
  withPinnedExclusiveLockAsync,
  unlinkPinnedFile,
  writePinnedFile,
  type PinnedDirectory,
} from './fs-safety.js';
function sanitizeServerText(value: unknown, maxBytes = 4096): string {
  return stripAnsi(value instanceof Error ? value.message : String(value))
    .replace(/([?&](?:token|authorization|x-ux-e2e-token)=)[^&\s]+/giu, '$1<redacted>')
    .replace(/[\n\t]/gu, ' ')
    .slice(0, maxBytes);
}
/**
 * Proxy env vars to strip when `keepProxyEnv` is false. Both upper and
 * lower variants are listed because POSIX permits mixed-case names and
 * tools like curl/Python honour the lowercase form. Ported from
 * @pi-harness/web-terminal buildPtyEnv.
 */
export const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'all_proxy',
  'no_proxy',
] as const;

/**
 * Build the env passed to `pty.spawn`. Merges `process.env` with caller
 * overrides, pins TERM, and (by default) deletes the proxy env vars so a
 * hostile or corporate proxy cannot MITM LLM/API calls. Pass
 * `keepProxyEnv: true` to opt out.
 */
export function buildPtyEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  overrides: Readonly<Record<string, string>> | undefined,
  opts: { readonly keepProxyEnv?: boolean } = {},
): Record<string, string> {
  const env: Record<string, string> = {
    ...(baseEnv as Record<string, string>),
    ...(overrides ?? {}),
    TERM: 'xterm-256color',
  };
  if (opts.keepProxyEnv !== true) {
    // Remove proxy vars after the spread so no source can sneak them in.
    for (const key of PROXY_ENV_KEYS) delete env[key];
  }
  return env;
}

/**
 * Perm tightening for the session evidence files. The default umask is
 * 0o022, which leaves session.json + transcript.jsonl world-readable on
 * multi-user hosts — exposing the bearer token and the full PTY I/O.
 * writeFileSync({mode:0o600}) pins the mode at create time; chmodSync
 * is the belt-and-braces second pass because umask can still narrow
 * the effective bits on some platforms.
 */
export const SESSION_FILE_MODE = 0o600;
export const SESSION_DIR_MODE = 0o700;


/**
 * Strip terminal controls before text is serialized for human-facing
 * metadata. Evidence files remain raw and are never rendered here.
 */
export function sanitizeForJson(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(
    /(?:\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|(?:P|X|\^|_)[^\u001b]*(?:\u001b\\)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])|\u009d[^\u0007]*(?:\u0007|\u001b\\)|[\u0090\u0098\u009e\u009f][^\u001b]*(?:\u001b\\)|\u009b[0-?]*[ -/]*[@-~]|[\u0080-\u009c]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r])/gu,
    '',
  );
}
/* ------------------------------------------------------------------ */
/* Token primitives                                                    */
/* ------------------------------------------------------------------ */

const TOKEN_BYTES = 32;

/** Convert raw bytes to a URL-safe base64 string (no padding). */
function toUrlSafeBase64(buf: Uint8Array): string {
  return Buffer.from(buf)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/u, '');
}

/** Mint a fresh 256-bit URL-safe token. */
export function mintToken(): string {
  return toUrlSafeBase64(randomBytes(TOKEN_BYTES));
}

/**
 * Constant-time string comparison. Both inputs are UTF-8 encoded; a
 * length mismatch still performs a dummy comparison to keep timing flat.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab);
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/* ------------------------------------------------------------------ */
/* Rate limiting + idle timer                                          */
/* ------------------------------------------------------------------ */

export interface RateLimitOptions {
  /** Max inbound messages per `windowMs`. Default 200. */
  readonly maxMessages?: number;
  /** Window length in ms. Default 1000. */
  readonly windowMs?: number;
}

/** Rolling-window inbound message rate limiter (per connection). */
export class RateLimiter {
  readonly #maxMessages: number;
  readonly #windowMs: number;
  readonly #samples: number[] = [];

  constructor(opts: RateLimitOptions = {}) {
    this.#maxMessages = opts.maxMessages ?? 200;
    this.#windowMs = opts.windowMs ?? 1000;
  }

  /** Record one inbound event. Returns true if the limit is respected. */
  record(now: number = Date.now()): boolean {
    const cutoff = now - this.#windowMs;
    while (this.#samples.length > 0 && (this.#samples[0] ?? 0) <= cutoff) {
      this.#samples.shift();
    }
    if (this.#samples.length >= this.#maxMessages) return false;
    this.#samples.push(now);
    return true;
  }

  /** Number of messages observed in the current window. */
  observed(now: number = Date.now()): number {
    const cutoff = now - this.#windowMs;
    let n = 0;
    for (const t of this.#samples) if (t > cutoff) n += 1;
    return n;
  }
}

export interface IdleTimerOptions {
  /** Idle window in ms; default 5 minutes. */
  readonly idleMs?: number;
  /** Invoked when the timer fires — typically closes the socket. */
  readonly onIdle: () => void;
}

/** Idle timer — resets on every `bump()`, fires `onIdle` after `idleMs` of silence. */
export class IdleTimer {
  readonly #idleMs: number;
  readonly #onIdle: () => void;
  #handle: NodeJS.Timeout | null = null;
  #fired = false;

  constructor(opts: IdleTimerOptions) {
    this.#idleMs = opts.idleMs ?? 5 * 60 * 1000;
    this.#onIdle = opts.onIdle;
  }

  /** Reset the idle countdown. Safe to call from any context. */
  bump(): void {
    if (this.#fired) return;
    if (this.#handle !== null) clearTimeout(this.#handle);
    const h = setTimeout(() => {
      this.#fired = true;
      this.#onIdle();
    }, this.#idleMs);
    if (typeof (h as { unref?: () => void }).unref === 'function') {
      (h as { unref: () => void }).unref();
    }
    this.#handle = h;
  }

  /** Stop counting and fire `onIdle` immediately (used on explicit shutdown). */
  fireNow(): void {
    if (this.#fired) return;
    this.#fired = true;
    if (this.#handle !== null) clearTimeout(this.#handle);
    this.#handle = null;
    this.#onIdle();
  }

  /** Resume the idle countdown after a retryable shutdown failure. */
  reset(): void {
    this.#fired = false;
    this.bump();
  }

  /** True if the idle timeout has already fired. */
  get fired(): boolean {
    return this.#fired;
  }
}


/* ------------------------------------------------------------------ */
/* omp launch arguments                                                */
/* ------------------------------------------------------------------ */

export interface OmpLaunchConfig {
  /**
   * Optional omp profile name. When set, omp is launched with
   * `--profile <name>`, which keeps auth, sessions, caches and
   * `models.db` inside that profile's isolated directory.
   *
   * When unset, NO `--profile` flag is passed and omp inherits the
   * default profile (`~/.omp/agent/`) — including the host's
   * `modelRoles`, `models.db`, and credentials. This is the right
   * default for UX testing: an explicit `ompProfile` isolates the
   * ux-e2e run from the host's data; inheriting lets the run use the
   * same models the operator uses day-to-day.
   */
  readonly ompProfile?: string;
  readonly maxTimeSec: number;
  readonly approvalMode: string;
  readonly configPath: string;
  readonly sessionDir: string;
  /**
   * Optional path to the *host* `~/.omp/agent/config.yml` to load as the
   * FIRST `--config` overlay. omp merges overlays in argv order, with
   * later overlays overriding earlier ones for duplicate keys (verified
   * against `omp v17.2.3 --help`: `--config=<value>  Load an extra
   * config.yml-style overlay for this run (repeatable)`). Putting the
   * host config FIRST and the ux-e2e overlay SECOND means:
   *   - keys NOT touched by the overlay (most importantly `modelRoles`)
   *     come from the host, so omp boots with a real model instead of
   *     "No model selected";
   *   - keys the overlay explicitly sets (e.g. session-dir-relative
   *     scratch bits) win over the host's defaults.
   */
  readonly hostConfigPath?: string;
  /**
   * Optional path to a *user-supplied* omp config overlay emitted AFTER
   * `configPath` (the standard ux-e2e overlay). This is the third and
   * last `--config` in argv order, so its keys win over both the host
   * config and the standard overlay on conflict — letting a test run
   * pin a specific active model (`modelRoles`) without touching the
   * operator's host config or the regenerated standard overlay.
   *
   * The harness only resolves this path when the file actually exists
   * (presence is the opt-in signal); an unset/falsy value is the normal
   * case and is recorded as `null` in `session.json` for diagnostics.
   */
  readonly userConfigPath?: string;
  /**
   * Convenience: absolute path to the canonical user-overlay file
   * (`<scratchDir>/.omp/ux-e2e-overlay.user.json`). Exposed so the
   * caller can decide whether to pass `userConfigPath`. Always set —
   * its existence at runtime is what determines whether the third
   * `--config` is emitted.
   */
  readonly userConfigDefaultPath: string;
  /**
   * Absolute package root for the one workspace-linked runtime extension.
   * When set, ambient extension discovery is disabled and this package is
   * loaded through the explicit `--extension` CLI path.
   */
  readonly runtimeExtensionPath?: string;
}

/**
 * Build the omp argument vector. NEVER passes `-p`/`--print` and NEVER
 * `--no-pty` — the session must be a real interactive PTY.
 *
 * `--profile` is emitted only when `cfg.ompProfile` is a non-empty
 * string. With NO profile, omp inherits the host default profile
 * (`~/.omp/agent/`) — including `modelRoles`, `models.db`, and
 * credentials — so the run is model-capable out of the box. An
 * explicit `ompProfile` keeps ux-e2e data isolated; the caller picks.
 *
 * When `runtimeExtensionPath` is present, `--no-extensions` is paired with
 * one explicit absolute package root, so installed/user/project ambient
 * extension discovery cannot add another provider.
 *
 * `--config` overlay order (argv order, later wins on conflict):
 *   1. `hostConfigPath` (operator's `~/.omp/agent/config.yml` when present)
 *   2. `configPath` (the regenerated ux-e2e overlay)
 *   3. `userConfigPath` (operator-supplied `<scratchDir>/.omp/ux-e2e-overlay.user.json`
 *      when present — third overlay so it overrides everything)
 */
export function buildOmpArgs(cfg: OmpLaunchConfig): string[] {
  const maxSeconds = Math.max(1, Math.ceil(cfg.maxTimeSec));
  const maxTime = maxSeconds % 60 === 0 ? `${maxSeconds / 60}m` : `${maxSeconds}s`;
  const args: string[] = [];
  if (typeof cfg.ompProfile === 'string' && cfg.ompProfile.length > 0) {
    args.push('--profile', cfg.ompProfile);
  }
  if (cfg.runtimeExtensionPath !== undefined) {
    if (!isAbsolute(cfg.runtimeExtensionPath) || cfg.runtimeExtensionPath.length === 0) {
      throw new Error('ux-e2e: runtime extension path must be absolute');
    }
    // Installed plugins are ambient by default. Disable that discovery and
    // name exactly one package root so a global/user copy cannot register a
    // second workflow tool set.
    args.push('--no-extensions', '--extension', cfg.runtimeExtensionPath);
  }
  if (cfg.hostConfigPath !== undefined && cfg.hostConfigPath.length > 0) {
    args.push('--config', cfg.hostConfigPath);
  }
  args.push('--config', cfg.configPath);
  if (cfg.userConfigPath !== undefined && cfg.userConfigPath.length > 0) {
    args.push('--config', cfg.userConfigPath);
  }
  args.push(
    '--session-dir', cfg.sessionDir,
    '--hide-thinking',
    '--max-time', maxTime,
    '--approval-mode', cfg.approvalMode,
  );
  return args;
}

/**
 * Default location of the user's host omp config (the "real" ~/.omp
 * that ships API keys + modelRoles). Inherited by every ux-e2e session
 * via `--config` so omp boots with a model; without this, the
 * ux-e2e-overlay alone (which only sets session bookkeeping) has no
 * `modelRoles` and omp prints "No model selected".
 */
export function defaultHostOmpConfigPath(): string {
  return join(homedir(), '.omp', 'agent', 'config.yml');
}

export interface HostConfigCheck {
  /** The host config path, when it exists AND is readable. */
  readonly path: string | null;
  /** Human-readable warning, or null when the config is healthy. */
  readonly warning: string | null;
}

/**
 * Resolve the host omp config and return a warning if it is missing,
 * unreadable, or has no `modelRoles`. omp config.yml uses a small
 * subset of YAML — keys are top-level strings, values can be mappings.
 * We do a defensive key scan: any non-empty `modelRoles` value
 * (mapping, list, or string) is treated as configured; a missing or
 * empty value is the failure mode the warning calls out.
 */
export function checkHostOmpConfig(path: string = defaultHostOmpConfigPath()): HostConfigCheck {
  const parent = pinDirectory(dirname(path));
  if (parent === null) {
    return {
      path: null,
      warning: `host omp config not found or unsafe at ${sanitizeServerText(path)}; omp will boot without a model. Set OMP_BIN's profile or provide ~/.omp/agent/config.yml with a 'modelRoles' block.`,
    };
  }
  let bodyBytes: Buffer | null;
  try {
    bodyBytes = readPinnedFileFull(parent, basename(path), 8 * 1024 * 1024);
  } finally {
    closePinnedDirectory(parent);
  }
  if (bodyBytes === null) {
    return {
      path: null,
      warning: `host omp config at ${sanitizeServerText(path)} is unreadable or unsafe; omp will boot without a model. Set OMP_BIN's profile or provide ~/.omp/agent/config.yml with a 'modelRoles' block.`,
    };
  }
  const body = bodyBytes.toString('utf8');
  // Cheap YAML key check — we look for a top-level `modelRoles:` line
  // (possibly with leading whitespace) followed by a non-empty value on
  // the next non-empty line. This is good enough for the
  // "operator forgot to set a model" smoke check; omp itself will
  // emit the authoritative error if the YAML is malformed.
  const lines = body.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    if (!/^\s*modelRoles\s*:/u.test(line)) continue;
    // Look at the RAW next lines for an indented continuation: a sibling
    // top-level key is NOT a value, so we require the next non-empty,
    // non-comment line to start with whitespace (or be a YAML block
    // scalar marker like `|` / `>`).
    for (let j = i + 1; j < lines.length; j += 1) {
      const raw = lines[j] ?? '';
      const trimmed = raw.trim();
      if (trimmed.length === 0 || trimmed.startsWith('#')) continue;
      if (trimmed === '|' || trimmed === '>' || trimmed.startsWith('|') || trimmed.startsWith('>')) {
        return { path, warning: null };
      }
      // Indented lines are the value (mapping entries, list items,
      // or scalar strings).
      if (/^\s+/u.test(raw)) return { path, warning: null };
      // Unindented line = a different top-level key, modelRoles is empty.
      return {
        path,
        warning: `host omp config at ${sanitizeServerText(path)} has 'modelRoles:' but no value follows; omp will boot without a model.`,
      };
    }
    // modelRoles was the last key in the file and had no value.
    return {
      path,
      warning: `host omp config at ${sanitizeServerText(path)} has 'modelRoles:' but no value follows; omp will boot without a model.`,
    };
  }
  return {
    path,
    warning: `host omp config at ${sanitizeServerText(path)} has no 'modelRoles' key; omp will boot without a model.`,
  };
}


/* ------------------------------------------------------------------ */
/* Session types                                                       */
/* ------------------------------------------------------------------ */

export interface ScenarioRef {
  readonly id: string;
  readonly title?: string;
  readonly selectors?: ScenarioSelectors;
  readonly workspace?: ScenarioWorkspacePaths;
  readonly transcript?: ScenarioTranscriptExpectations;
}

export interface TestSessionOptions {
  /** PTY working directory (scratch project). Required. */
  readonly cwd: string;
  /** Driving surface: 'web' (xterm in browser) or 'text' (WS transcript). Default 'web'. */
  readonly surface?: 'web' | 'text';
  /** Scenario reference stored in session.json for the report. */
  readonly scenario?: ScenarioRef | null;
  /** Port — default 0 (ephemeral). */
  readonly port?: number;
  /** Initial PTY cols. Default 100. */
  readonly cols?: number;
  /** Initial PTY rows. Default 30. */
  readonly rows?: number;
  /** Idle timeout in ms — closes the session after no inbound traffic. Default 20 min. */
  readonly idleMs?: number;
  /** Inbound rate limit per connection. Default 200 msgs / 1000 ms. */
  readonly rateLimit?: RateLimitOptions;
  /** omp binary. Default `$OMP_BIN` else `omp`. */
  readonly ompBinary?: string;
  /**
   * omp profile name. Default: unset — omp inherits the host default
   * profile (`~/.omp/agent/`), so `modelRoles` + credentials come from
   * the host's real config. Pass a name to isolate the run into its
   * own profile directory (caller-managed).
   */
  readonly ompProfile?: string;
  /** Session time budget in seconds. Default 1800 (30 min). */
  readonly maxTimeSec?: number;
  /** omp approval mode. Default 'yolo'. */
  readonly approvalMode?: string;
  /** Task prompt recorded in session.json. */
  readonly taskPrompt?: string | null;
  /** Extra env vars merged on top of `process.env` (TERM is forced). */
  readonly env?: Readonly<Record<string, string>>;
  /** Internal detached parent abort channel; checked before PTY ownership starts. */
  readonly startupAbortSignal?: AbortSignal;
  /** Internal detached-start nonce; otherwise freshly minted. */
  readonly serverStartNonce?: string;
  /** Pre-minted token override (tests). Default: freshly minted. */
  readonly token?: string;
  /**
   * Disable the PTY entirely — the server stays up and the WS protocol
   * works, but there is no process to drive. ONLY for server unit tests;
   * never for real e2e runs.
   */
  readonly noPty?: boolean;
  /**
   * Keep proxy env vars (HTTP_PROXY etc.) when spawning the PTY. Default
   * false — they are stripped to prevent a hostile or corporate proxy
   * from MITMing LLM/API calls. Pass true to opt out.
   */
  readonly keepProxyEnv?: boolean;
}

/** Handle to a running test session. */
export interface TestSession {
  readonly host: '127.0.0.1';
  readonly publicHost: string;
  readonly port: number;
  /** Internal bearer used by the WS driver; never print or expose in UI output. */
  readonly token: string;
  readonly sessionId: string;
  readonly controlNonce: string;
  /** Internal URL retained for programmatic WS clients. */
  readonly url: string;
  /** One-time browser bootstrap URL; contains only a short-lived code. */
  readonly browserUrl: string;
  /** WebSocket path, e.g. `/ws`. The token goes in `?token=` (see `url`). */
  readonly wsPath: string;
  readonly scratchDir: string;
  readonly transcriptPath: string;
  readonly sessionJsonPath: string;
  readonly pty: { readonly pid: number | null; readonly cols: number; readonly rows: number; readonly mode: 'pty' | 'noPty' };
  /** Stop the authenticated server and its owned PTY. */
  readonly close: () => Promise<void>;
}
/* ------------------------------------------------------------------ */
/* Session.json + concurrency guard                                    */
/* ------------------------------------------------------------------ */

export interface SessionInfo {
  readonly pid: number | null;
  /** Process group containing the currently owned startup/runtime tree. */
  readonly pgid: number | null;
  /** Startup/runtime phase persisted before each owned child is spawned. */
  readonly phase: string | null;
  /** Version probe process identity, when a probe is in flight/recoverable. */
  readonly probePid: number | null;
  readonly probePgid: number | null;
  readonly probeStartIdentity: string | null;
  readonly ptyStartIdentity: string | null;
  readonly startedAt: string | null;
  readonly path: string;
  readonly schemaVersion: number | null;
  readonly sessionId: string | null;
  readonly token: string | null;
  readonly controlNonce: string | null;
  readonly serverPid: number | null;
  readonly serverStartIdentity: string | null;
  readonly serverStartNonce: string | null;
  readonly url: string | null;
  readonly ompVersion: string | null;
  readonly spawnError: string | null;
  readonly browserUrl: string | null;
  readonly status: 'starting' | 'running' | 'shutdown_failed' | 'stopped' | null;
  /** True only after the owned PTY/controller shutdown has been observed. */
  readonly ptyExitObserved: boolean;
  /** Set with the stopped transition, after exact shutdown observation. */
  readonly shutdownCompletedAt: string | null;
  readonly stoppedAt: string | null;
  readonly finishedAt: string | null;
  readonly shutdownError: string | null;
}

function boundedSessionString(value: unknown, max = 512): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}
/** One line of the server-side transcript.jsonl (evidence backbone). */
export type TranscriptFrame =
  | { readonly ts: string; readonly t: 'o'; readonly d: string }
  | {
      readonly ts: string;
      readonly t: 'i';
      readonly d: string;
      readonly sequence?: number | null;
      readonly reservation_id?: string | null;
      readonly step_index?: number;
      readonly step_count?: number;
      readonly is_final_submit?: boolean;
    }
  | { readonly ts: string; readonly t: 'exit'; readonly code: number; readonly signal?: number }
  | { readonly ts: string; readonly t: 'err'; readonly code: string; readonly message?: string };

function boundedSessionPid(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647 ? value : null;
}

/** Read `<scratch>/.work-state/ux-e2e/session.json` through its pinned directory. */
export function readSessionInfo(scratchDir: string): SessionInfo | null {
  const stateDir = join(scratchDir, '.work-state', 'ux-e2e');
  const root = pinDirectory(stateDir);
  if (root === null) return null;
  try {
    const bytes = readPinnedFileFull(root, 'session.json', 1024 * 1024);
    if (bytes === null) return null;
    const j = JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
    if (j['schema_version'] !== 2) return null;
    const requiredV2Keys = [
      'pid',
      'pty_start_identity',
      'browser_url',
      'spawn_error',
      'pty_exit_observed',
      'shutdown_completed_at',
      'stopped_at',
      'finished_at',
      'shutdown_error',
    ] as const;
    if (requiredV2Keys.some(key => !Object.prototype.hasOwnProperty.call(j, key))) return null;
    const statusValue = j['status'];
    const status = statusValue === 'starting' || statusValue === 'running'
      || statusValue === 'shutdown_failed' || statusValue === 'stopped'
      ? statusValue
      : null;
    if (status === null) return null;
    const ptyExitObservedValue = j['pty_exit_observed'];
    if (typeof ptyExitObservedValue !== 'boolean') return null;
    const ptyExitObserved = ptyExitObservedValue;
    const readLifecycleTimestamp = (name: string): string | null => {
      const value = j[name];
      if (value === null) return null;
      const parsed = boundedSessionString(value, 64);
      return parsed !== null && !Number.isNaN(Date.parse(parsed)) ? parsed : null;
    };
    const shutdownCompletedAt = readLifecycleTimestamp('shutdown_completed_at');
    const stoppedAt = readLifecycleTimestamp('stopped_at');
    const finishedAt = readLifecycleTimestamp('finished_at');
    if (
      (j['shutdown_completed_at'] !== null && shutdownCompletedAt === null)
      || (j['stopped_at'] !== null && stoppedAt === null)
      || (j['finished_at'] !== null && finishedAt === null)
    ) return null;
    const shutdownErrorValue = j['shutdown_error'];
    const shutdownError = shutdownErrorValue === null
      ? null
      : boundedSessionString(shutdownErrorValue, 1024);
    if (shutdownErrorValue !== null && shutdownError === null) return null;
    if (status === 'stopped' && (!ptyExitObserved || shutdownCompletedAt === null || stoppedAt === null || finishedAt === null
      || stoppedAt !== finishedAt)) return null;
    if (status !== 'stopped' && (ptyExitObserved || shutdownCompletedAt !== null || stoppedAt !== null || finishedAt !== null)) return null;
    const pid = j['pid'] === null ? null : boundedSessionPid(j['pid']);
    const pgid = j['pgid'] === null || j['pgid'] === undefined ? null : boundedSessionPid(j['pgid']);
    const phase = j['phase'] === null || j['phase'] === undefined ? null : boundedSessionString(j['phase'], 64);
    const probePid = j['probe_pid'] === null || j['probe_pid'] === undefined ? null : boundedSessionPid(j['probe_pid']);
    const probePgid = j['probe_pgid'] === null || j['probe_pgid'] === undefined ? null : boundedSessionPid(j['probe_pgid']);
    const probeStartIdentity = j['probe_start_identity'] === null || j['probe_start_identity'] === undefined ? null : boundedSessionString(j['probe_start_identity'], 128);
    const ptyStartIdentity = j['pty_start_identity'] === null
      ? null
      : boundedSessionString(j['pty_start_identity'], 128);
    const serverPid = boundedSessionPid(j['server_pid']);
    const serverStartIdentity = boundedSessionString(j['server_start_identity'], 128);
    const startedAt = boundedSessionString(j['started_at'], 64);
    if (j['pid'] !== null && (pid === null
      || (ptyStartIdentity === null && status !== 'starting' && status !== 'shutdown_failed'))) return null;
    if (j['pgid'] !== undefined && j['pgid'] !== null && pgid === null) return null;
    if (j['phase'] !== undefined && j['phase'] !== null && phase === null) return null;
    if (j['probe_pid'] !== undefined && j['probe_pid'] !== null && probePid === null) return null;
    if (j['probe_pgid'] !== undefined && j['probe_pgid'] !== null && probePgid === null) return null;
    if (j['probe_start_identity'] !== undefined && j['probe_start_identity'] !== null && probeStartIdentity === null) return null;
    if (serverPid === null || serverStartIdentity === null || startedAt === null
      || Number.isNaN(Date.parse(startedAt))) return null;
    const sessionId = boundedSessionString(j['session_id'], 128);
    const token = boundedSessionString(j['token'], 256);
    const controlNonce = boundedSessionString(j['control_nonce'], 256);
    const serverStartNonce = boundedSessionString(j['server_start_nonce'], 256);
    const url = boundedSessionString(j['url'], 2048);
    const browserUrl = boundedSessionString(j['browser_url'], 2048);
    const browserBootstrapConsumedValue = j['browser_bootstrap_consumed'];
    if (browserBootstrapConsumedValue !== undefined && typeof browserBootstrapConsumedValue !== 'boolean') return null;
    const browserBootstrapConsumed = browserBootstrapConsumedValue === true;
    if (sessionId === null || token === null || controlNonce === null
      || serverStartNonce === null || url === null) return null;
    if (browserBootstrapConsumed ? j['browser_url'] !== null : browserUrl === null) return null;
    const ompVersion = j['omp_version'] === null
      ? null
      : boundedSessionString(j['omp_version'], 256);
    if (j['omp_version'] !== null && ompVersion === null) return null;
    // A pre-probe startup failure may converge directly to terminal stopped
    // without ever having a version to publish.
    if (ompVersion === null && status !== 'starting' && status !== 'shutdown_failed' && status !== 'stopped') return null;
    const spawnError = j['spawn_error'] === null
      ? null
      : boundedSessionString(j['spawn_error'], 1024);
    if (j['spawn_error'] !== null && spawnError === null) return null;
    return {
      pid: pid ?? null,
      pgid,
      phase,
      probePid,
      probePgid,
      probeStartIdentity,
      ptyStartIdentity,
      startedAt,
      path: join(stateDir, 'session.json'),
      schemaVersion: 2,
      sessionId,
      token,
      controlNonce,
      serverPid,
      serverStartIdentity,
      serverStartNonce,
      ompVersion,
      spawnError,
      browserUrl,
      url,
      status,
      ptyExitObserved,
      shutdownCompletedAt,
      stoppedAt,
      finishedAt,
      shutdownError,
    };
  } catch {
    return null;
  } finally {
    closePinnedDirectory(root);
  }
}

/** Read the process group id for an owned process. */
function processGroupId(pid: number): number | null {
  if (!Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "pgid="], { encoding: "utf8", timeout: 1000, maxBuffer: 4096, stdio: ["ignore", "pipe", "ignore"] });
    if (result.status !== 0) return null;
    const group = Number(result.stdout.trim());
    return Number.isSafeInteger(group) && group > 0 ? group : null;
  } catch {
    return null;
  }
}

function captureProbeStartIdentity(pid: number): string | null {
  // Use the same authenticated process-generation probe as PTY ownership.
  // Besides keeping the two ownership paths identical, this preserves the
  // safety test seam for a deterministic unavailable-identity probe.
  return processStartIdentity(pid);
}

let processGroupSignalTestHook: ((pgid: number) => void) | null = null;
let startupPostSpawnFailureTestHook: ((context: { readonly port: number; readonly token: string; readonly origin: string }) => Promise<Error | null>) | null = null;

/** Test-only seam: records an authenticated group signal without touching a real PID. */
export function setProcessGroupSignalTestHook(hook: ((pgid: number) => void) | null): void {
  processGroupSignalTestHook = hook;
}

/** Test-only seam: injects a post-spawn startup failure for rollback tests. */
export function setStartupPostSpawnFailureTestHook(
  hook: ((context: { readonly port: number; readonly token: string; readonly origin: string }) => Promise<Error | null>) | null,
): void {
  startupPostSpawnFailureTestHook = hook;
}

export function signalOwnedGroupForTest(pid: number | null, pgid: number | null, startIdentity: string | null): boolean {
  return signalOwnedGroup(pid, pgid, startIdentity);
}

function signalOwnedGroup(pid: number | null, pgid: number | null, startIdentity: string | null): boolean {
  if (pid === null || pgid === null || startIdentity === null || processStartIdentity(pid) !== startIdentity) return false;
  try {
    if (processGroupSignalTestHook !== null) {
      processGroupSignalTestHook(pgid);
      return true;
    }
    process.kill(-pgid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

/** True if the pid refers to a live process on this host and, when supplied, the expected process generation. */
export function pidIsLive(pid: number | null | undefined, expectedStartIdentity?: string | null): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return expectedStartIdentity === undefined || (
      expectedStartIdentity !== null && processStartIdentity(pid) === expectedStartIdentity
    );
  } catch {
    return false;
  }
}
export function assertNoLiveSession(scratchDir: string, _force: boolean): void {
  const stateDir = join(scratchDir, '.work-state', 'ux-e2e');
  const info = readSessionInfo(scratchDir);
  if (info === null) {
    const stateRoot = pinDirectory(stateDir);
    if (stateRoot === null) {
      try {
        lstatSync(stateDir);
      } catch {
        return;
      }
      throw new Error('ux-e2e: session state directory is not a safe pinned directory; refusing start');
    }
    try {
      if (readPinnedFileFull(stateRoot, 'session.json', 1024 * 1024) !== null) {
        throw new Error('ux-e2e: malformed or unsupported session metadata; refusing start');
      }
      try {
        lstatSync(join(stateDir, 'session.json'));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw new Error('ux-e2e: session metadata is not a safe regular file; refusing start');
      }
      throw new Error('ux-e2e: malformed or unsupported session metadata; refusing start');
    } finally {
      closePinnedDirectory(stateRoot);
    }
  }
  const shutdownProven = info.status === 'stopped'
    && info.ptyExitObserved
    && info.shutdownCompletedAt !== null;
  if (shutdownProven) return;
  // A version probe is a separately-owned child. A non-null pid with no
  // captured generation cannot be classified as dead or reused safely; keep
  // admission closed until its close event is reflected by terminal metadata.
  if (info.probePid !== null && info.probeStartIdentity === null) {
    throw new Error('ux-e2e: prior version probe has no authenticated process identity; refusing start until durable stopped/exit proof');
  }
  if (info.probePid !== null && info.probeStartIdentity !== null
    && pidIsLive(info.probePid, info.probeStartIdentity)) {
    throw new Error('ux-e2e: prior version probe remains live; refusing start until it is stopped');
  }
  if (info.ptyStartIdentity === null) {
    throw new Error('ux-e2e: prior session has no authenticated PTY process identity; refusing start until durable stopped/exit proof');
  }
  const serverLive = pidIsLive(info.serverPid, info.serverStartIdentity);
  const ptyLive = pidIsLive(info.pid, info.ptyStartIdentity);
  if (!serverLive && !ptyLive) return;
  if (!serverLive) {
    throw new Error('ux-e2e: prior session server is unavailable while its PTY remains live; refusing start');
  }
  throw new Error(
    `ux-e2e: live session found (server pid ${String(info.serverPid)}) at ${info.path}; stop it before starting another session`,
  );
}

/* ------------------------------------------------------------------ */
/* HTTP security headers + CSP                                         */
/* ------------------------------------------------------------------ */

export function securityHeaders(host: string, port: number): Readonly<Record<string, string>> {
  return {
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Embedder-Policy': 'require-corp',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Content-Security-Policy': cspHeader(`http://${host}:${port}`),
  };
}

/**
 * Strict CSP — full set, ported from @pi-harness/web-terminal origin.ts.
 * The page only loads its own bundle (`'self'`); inline `style` attributes
 * are required by xterm.js so `'unsafe-inline'` is allowed in `style-src`
 * but never in `script-src` or `connect-src`. `connect-src` includes the
 * same-origin WS so a malicious page cannot convince the browser to open
 * an arbitrary WS upgrade using a stolen token.
 */
export function cspHeader(selfOrigin: string): string {
  let wsSelf = '';
  try {
    const u = new URL(selfOrigin);
    wsSelf = u.protocol === 'https:' ? `wss://${u.host}` : `ws://${u.host}`;
  } catch {
    /* keep connect-src minimal on parse failure */
  }
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    "style-src 'self' 'unsafe-inline'",
    "script-src 'self'",
    "connect-src 'self' " + wsSelf,
    "object-src 'none'",
    "manifest-src 'self'",
  ].join('; ');
}
/* ------------------------------------------------------------------ */
/* Static assets (terminal page + vendored xterm)                      */
/* ------------------------------------------------------------------ */

interface VendorAssets {
  readonly terminalHtml: string;
  readonly pageJs: string;
  readonly xtermJs: string;
  readonly xtermCss: string;
  readonly addonFitJs: string;
}

const require = createRequire(import.meta.url);

const assetCache = new Map<string, Buffer>();

function resolveVendorAssets(): VendorAssets {
  // NOTE: @xterm/xterm ships its stylesheet under `css/xterm.css`, NOT
  // `lib/xterm.css` (verified against 5.5.0). The JS bundles live in `lib/`.
  return {
    terminalHtml: fileURLToPath(new URL('../assets/terminal.html', import.meta.url)),
    pageJs: fileURLToPath(new URL('../assets/page.js', import.meta.url)),
    xtermJs: require.resolve('@xterm/xterm/lib/xterm.js'),
    xtermCss: require.resolve('@xterm/xterm/css/xterm.css'),
    addonFitJs: require.resolve('@xterm/addon-fit/lib/addon-fit.js'),
  };
}


function serveFile(res: ServerResponse, path: string, contentType: string): void {
  let body = assetCache.get(path);
  if (body === undefined) {
    try {
      body = readFileSync(path);
      assetCache.set(path, body);
    } catch {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('not found');
      return;
    }
  }
  res.setHeader('Content-Type', contentType);
  res.end(body);
}

function pathnameOf(req: IncomingMessage): string {
  const raw = req.url ?? '/';
  const qIdx = raw.indexOf('?');
  const path = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
  return path === '' ? '/' : path;
}

/* ------------------------------------------------------------------ */
/* WS auth + session attach                                            */
/* ------------------------------------------------------------------ */

export type ServerMsg =
  | { readonly t: 's'; readonly ok: true }
  | { readonly t: 'o'; readonly d: string }
  | { readonly t: 'exit'; readonly code: number; readonly signal?: number }
  | { readonly t: 'err'; readonly code: string; readonly message: string }
  | {
      readonly t: 'ack';
      readonly sequence: number;
      readonly reservation_id?: string;
      readonly step_index: number;
      readonly step_count: number;
      readonly is_final_submit: boolean;
    };

/** Inbound WS messages from the browser. */
type ClientMsg =
  | {
      readonly t: 'i';
      readonly d: string;
      readonly sequence?: number;
      readonly reservation_id?: string;
      readonly step_index?: number;
      readonly step_count?: number;
      readonly is_final_submit?: boolean;
    }
  | { readonly t: 'r'; readonly cols: number; readonly rows: number };

function send(ws: WS, msg: ServerMsg): boolean {
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

type SessionToken = { readonly token: string; readonly source: 'query' | 'cookie' };

function readToken(req: IncomingMessage): SessionToken | null {
  try {
    if (req.url !== undefined) {
      const t = new URL(req.url, 'http://placeholder.invalid/').searchParams.get('token');
      if (t !== null && t.length > 0 && t.length <= 256) return { token: t, source: 'query' };
    }
    const cookie = req.headers.cookie;
    if (typeof cookie !== 'string') return null;
    const match = /(?:^|;\s*)ux_e2e_session=([^;]+)/u.exec(cookie);
    if (match === null) return null;
    const value = decodeURIComponent(match[1] ?? '');
    return value.length > 0 && value.length <= 256 ? { token: value, source: 'cookie' } : null;
  } catch {
    return null;
  }
}

/**
 * Origin verification is exact against the canonical session origin. A
 * browser-authenticated cookie request must carry that Origin; the only
 * origin-less path is an explicit query-bearer request from the CLI.
 */
const ALIAS_PROTOCOLS = new Set(['http:', 'https:', 'ws:', 'wss:']);
const BRACKETED_V6 = /^\[([0-9a-fA-F:]+)\](?::(\d+))?$/u;
const HOST_PORT = /^([^:\[]+)(?::(\d+))?$/u;

/** Parse `host[:port]` where host may be IPv4, IPv6, or a DNS name. */
export function parseHostPort(value: string): { hostname: string; port: string } | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const v6 = BRACKETED_V6.exec(trimmed);
  if (v6 !== null) {
    const host = v6[1] ?? '';
    const port = v6[2] ?? '';
    return { hostname: host, port };
  }
  const m = HOST_PORT.exec(trimmed);
  if (m === null) return null;
  return { hostname: m[1] ?? '', port: m[2] ?? '' };
}

export function originAllowed(req: IncomingMessage, expectedOrigin: string, allowMissingOrigin = false): boolean {
  let expected: URL;
  try {
    expected = new URL(expectedOrigin);
  } catch {
    return false;
  }
  if (!ALIAS_PROTOCOLS.has(expected.protocol)) return false;
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || origin.length === 0) return allowMissingOrigin;
  let candidate: URL;
  try {
    candidate = new URL(origin);
  } catch {
    return false;
  }
  if (!ALIAS_PROTOCOLS.has(candidate.protocol)) return false;
  return candidate.origin === expected.origin;
}

export type AttachResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no-token' | 'bad-token' | 'bad-origin' | 'closed' };

interface SessionControllerOptions {
  readonly pty: IPty | null;
  readonly spawnError: string | null;
  readonly idleMs: number;
  readonly transcriptRoot: PinnedDirectory;
  readonly transcriptName: string;
  readonly deliveryRoot: PinnedDirectory;
  readonly deliveryName: string;
  readonly sessionId: string;
  readonly ptyExitPromise?: Promise<void>;
  readonly onPtyExit?: () => void;
  readonly onShutdownRequest?: () => void;
  readonly ptyExitTimeoutMs?: number;
  readonly ptyPgid?: number | null;
  readonly ptyStartIdentity?: string | null;
  readonly ptyExited?: boolean;
}

type SessionState = 'open' | 'closing' | 'closed';

class SessionController {
  readonly #opts: SessionControllerOptions;
  readonly #idler: IdleTimer;
  readonly #ptyExitPromise: Promise<void>;
  readonly #resolvePtyExit: (() => void) | null;
  readonly #attachedWs = new Set<WS>();
  #state: SessionState = 'open';
  #ptyExited = false;
  #ptyExitHandled = false;
  #closePromise: Promise<void> | null = null;
  #transcriptCapped = false;

  constructor(opts: SessionControllerOptions) {
    this.#opts = opts;
    this.#ptyExited = opts.ptyExited === true;
    let resolvePtyExit: (() => void) | null = null;
    this.#ptyExitPromise = opts.pty === null
      ? Promise.resolve()
      : opts.ptyExitPromise ?? new Promise<void>(resolve => { resolvePtyExit = resolve; });
    this.#resolvePtyExit = resolvePtyExit;
    this.#idler = new IdleTimer({
      idleMs: opts.idleMs,
      onIdle: () => {
        if (this.closed) return;
        const message = `no inbound traffic for ${opts.idleMs}ms`;
        for (const ws of this.#attachedWs) send(ws, { t: 'err', code: 'idle-timeout', message });
        this.#append({ ts: new Date().toISOString(), t: 'err', code: 'idle-timeout', message });
        this.#requestShutdown();
      },
    });
    opts.pty?.onData(data => this.#handlePtyData(data));
    opts.pty?.onExit(({ exitCode, signal }) => this.#handlePtyExit(exitCode, signal));
  }

  get closed(): boolean {
    return this.#state !== 'open';
  }

  attach(ws: WS): void {
    if (this.closed) {
      ws.close(1001, 'session closed');
      return;
    }
    this.#attachedWs.add(ws);
    this.#idler.bump();
    send(ws, { t: 's', ok: true });
    if (this.#opts.pty === null && this.#opts.spawnError !== null) {
      send(ws, { t: 'err', code: 'spawn-failed', message: this.#opts.spawnError });
      this.#append({ ts: new Date().toISOString(), t: 'err', code: 'spawn-failed', message: this.#opts.spawnError });
      ws.close(1000, 'spawn failed');
      this.#requestShutdown();
    }
  }

  detach(ws: WS): void {
    this.#attachedWs.delete(ws);
  }

  replayPtyExit(exitCode: number, signal: number | undefined): void {
    if (!this.#ptyExitHandled) {
      this.#handlePtyExit(exitCode, signal);
      return;
    }
    // The PTY may have notified the controller before stopControl was
    // installed. Re-run the shutdown request now that it has an owner.
    this.#requestShutdown();
  }

  handleMessage(ws: WS, raw: unknown, limiter: RateLimiter): void {

    if (this.closed || !this.#attachedWs.has(ws)) return;
    this.#idler.bump();
    if (!limiter.record()) {
      send(ws, { t: 'err', code: 'rate-limited', message: 'too many messages' });
      this.#append({ ts: new Date().toISOString(), t: 'err', code: 'rate-limited' });
      ws.close(1008, 'rate limited');
      return;
    }
    let msg: ClientMsg;
    try {
      const text = typeof raw === 'string' ? raw : String(raw);
      if (text.length > MAX_INBOUND_WS_BYTES) return;
      msg = JSON.parse(text) as ClientMsg;
    } catch {
      return;
    }
    if (this.#opts.pty === null) return;
    if (msg.t === 'i' && typeof msg.d === 'string' && msg.d.length <= MAX_INBOUND_WS_BYTES) {
      const sequence = typeof msg.sequence === 'number' && Number.isSafeInteger(msg.sequence) ? msg.sequence : null;
      const hasSequence = sequence !== null;
      const stepIndex = msg.step_index === undefined ? 1 : msg.step_index;
      const stepCount = msg.step_count === undefined ? 1 : msg.step_count;
      const isFinalSubmit = msg.is_final_submit === undefined ? false : msg.is_final_submit;
      if (!Number.isSafeInteger(stepIndex) || !Number.isSafeInteger(stepCount)
        || stepIndex < 1 || stepCount < 1 || stepIndex > stepCount
        || typeof isFinalSubmit !== 'boolean'
        || (msg.sequence !== undefined && (sequence === null || sequence <= 0 || sequence > 2_147_483_647))
        || (msg.reservation_id !== undefined
          && (typeof msg.reservation_id !== 'string' || msg.reservation_id.length === 0 || msg.reservation_id.length > 128))) {
        return;
      }
      const contentDigest = createHash('sha256').update(msg.d, 'utf8').digest('hex');
      const delivery = {
        ts: new Date().toISOString(),
        session_id: this.#opts.sessionId,
        reservation_id: msg.reservation_id ?? null,
        content_digest: contentDigest,
        content_length: msg.d.length,
        sequence: hasSequence ? sequence : null,
        step_index: stepIndex,
        step_count: stepCount,
        is_final_submit: isFinalSubmit,
        status: 'delivery_prepared' as const,
      };
      if (!this.#appendDelivery(delivery)) return;
      try {
        this.#opts.pty.write(msg.d);
        this.#append({
          ts: new Date().toISOString(),
          t: 'i',
          d: msg.reservation_id === undefined ? msg.d : '[input]',
          sequence: hasSequence ? sequence : null,
          reservation_id: msg.reservation_id ?? null,
          step_index: stepIndex,
          step_count: stepCount,
          is_final_submit: isFinalSubmit,
        });
        if (!this.#appendDelivery({ ...delivery, ts: new Date().toISOString(), status: 'delivered' })) return;
        if (hasSequence) {
          send(ws, {
            t: 'ack',
            sequence,
            ...(msg.reservation_id !== undefined ? { reservation_id: msg.reservation_id } : {}),
            step_index: stepIndex,
            step_count: stepCount,
            is_final_submit: isFinalSubmit,
          });
        }
      } catch { /* PTY may be dying; input remains retryable. */ }
    } else if (msg.t === 'r' && Number.isSafeInteger(msg.cols) && Number.isSafeInteger(msg.rows) && msg.cols > 0 && msg.rows > 0) {
      try { this.#opts.pty.resize(Math.min(msg.cols, 1000), Math.min(msg.rows, 1000)); } catch { /* PTY may be closing. */ }
    }
  }

  async close(): Promise<void> {
    if (this.#closePromise !== null) return this.#closePromise;
    // The admission fence is deliberately raised before touching sockets or
    // the PTY. A failed graceful stop reopens only in the rollback below.
    this.#state = 'closing';
    this.#idler.fireNow();
    for (const ws of this.#attachedWs) {
      try { ws.close(1001, 'session closed'); } catch { /* ignore */ }
    }
    this.#attachedWs.clear();
    const pty = this.#opts.pty;
    const closeAttempt = deferred<void>();
    this.#closePromise = closeAttempt.promise.catch(error => {
      // The PTY is still owned and retryable only after the failed close has
      // fully unwound. No caller can observe an open admission window during
      // the grace period or while this rollback is in progress.
      this.#idler.reset();
      this.#state = 'open';
      this.#closePromise = null;
      throw error;
    });
    void (async (): Promise<void> => {
      if (pty === null) {
        this.#state = 'closed';
        closeAttempt.resolve();
        return;
      }
      try {
        if (!this.#ptyExited) {
          const pgid = this.#opts.ptyPgid ?? processGroupId(pty.pid);
          let processStillLive = true;
          try { process.kill(pty.pid, 0); } catch { processStillLive = false; }
          if (!processStillLive) {
            this.#ptyExited = true;
            this.#resolvePtyExit?.();
          } else if (this.#opts.ptyStartIdentity === null) {
            throw new Error('ux-e2e: PTY identity unavailable; refusing unsafe signal');
          } else if (!signalOwnedGroup(pty.pid, pgid, this.#opts.ptyStartIdentity ?? null)) {
            throw new Error('ux-e2e: PTY process-group identity could not be authenticated');
          }
        }
        const timeoutMs = this.#opts.ptyExitTimeoutMs ?? 5_000;
        let timer: NodeJS.Timeout | undefined;
        try {
          await Promise.race([
            this.#ptyExitPromise,
            new Promise<never>((_resolve, reject) => {
              timer = setTimeout(() => reject(new Error('ux-e2e: PTY graceful exit could not be proven')), timeoutMs);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        this.#state = 'closed';
        closeAttempt.resolve();
      } catch (error) {
        closeAttempt.reject(error);
      }
    })();
    return this.#closePromise;
  }

  #handlePtyData(data: string): void {
    if (this.closed) return;
    this.#append({ ts: new Date().toISOString(), t: 'o', d: data });
    for (const ws of this.#attachedWs) send(ws, { t: 'o', d: data });
  }
  #handlePtyExit(exitCode: number, signal: number | undefined): void {
    if (this.#ptyExitHandled) return;
    this.#ptyExitHandled = true;
    this.#ptyExited = true;
    this.#resolvePtyExit?.();
    this.#append({
      ts: new Date().toISOString(),
      t: 'exit',
      code: exitCode,
      ...(signal !== undefined ? { signal } : {}),
    });
    if (this.closed) return;
    for (const ws of this.#attachedWs) {
      send(ws, { t: 'exit', code: exitCode, ...(signal !== undefined ? { signal } : {}) });
      try { ws.close(1000, 'pty exited'); } catch { /* ignore */ }
    }
    this.#attachedWs.clear();
    this.#state = 'closed';
    this.#idler.fireNow();
    this.#opts.onPtyExit?.();
  }

  #requestShutdown(): void {
    if (this.#opts.onShutdownRequest !== undefined) {
      this.#opts.onShutdownRequest();
    } else {
      void this.close().catch(error => {
        process.stderr.write(`ux-e2e: shutdown failed: ${sanitizeServerText(error)}\n`);
      });
    }
  }

  #appendDelivery(record: Record<string, unknown>): boolean {
    try {
      const payload = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
      let currentSize = 0;
      try {
        const info = lstatSync(join(this.#opts.deliveryRoot.lexicalPath, this.#opts.deliveryName));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return false;
        currentSize = info.size;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
      }
      if (currentSize > 8 * 1024 * 1024 - payload.length) return false;
      return appendPinnedFile(this.#opts.deliveryRoot, this.#opts.deliveryName, payload);
    } catch {
      return false;
    }
  }

  #append(frame: TranscriptFrame): void {
    if (this.#transcriptCapped) return;
    try {
      const ok = appendPinnedFile(
        this.#opts.transcriptRoot,
        this.#opts.transcriptName,
        Buffer.from(JSON.stringify(frame) + '\n', 'utf8'),
      );
      if (!ok) {
        this.#transcriptCapped = true;
        appendPinnedFile(
          this.#opts.transcriptRoot,
          this.#opts.transcriptName,
          Buffer.from(JSON.stringify({
            ts: new Date().toISOString(),
            t: 'err',
            code: 'transcript-truncated',
            message: 'transcript capacity reached; session is shutting down',
          }) + '\n', 'utf8'),
        );
        this.#requestShutdown();
      }
    } catch {
      this.#transcriptCapped = true;
      this.#requestShutdown();
    }
  }
}

interface AttachOptions {
  readonly origin: string;
  readonly rateLimit: Required<RateLimitOptions>;
  readonly controller: SessionController;
}

/** Authenticate a WS upgrade and attach it to the live PTY session. */
export function attachSession(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  expectedToken: string,
  opts: AttachOptions,
): AttachResult {
  const auth = readToken(req);
  if (auth === null) return { ok: false, reason: 'no-token' };
  if (!safeEqual(auth.token, expectedToken)) return { ok: false, reason: 'bad-token' };
  if (!originAllowed(req, opts.origin, auth.source === 'query')) return { ok: false, reason: 'bad-origin' };
  if (opts.controller.closed) return { ok: false, reason: 'closed' };

  wss.handleUpgrade(req, socket, head, ws => {
    const limiter = new RateLimiter(opts.rateLimit);
    opts.controller.attach(ws);
    ws.on('message', raw => opts.controller.handleMessage(ws, raw, limiter));
    ws.on('close', () => opts.controller.detach(ws));
    ws.on('error', () => opts.controller.detach(ws));
  });
  return { ok: true };
}

/* ------------------------------------------------------------------ */
/* Server bootstrap                                                    */
/* ------------------------------------------------------------------ */

function deriveSlug(scratchDir: string): string {
  const base = basename(scratchDir);
  const PREFIX = 'omp-ux-e2e-';
  return base.startsWith(PREFIX) ? base.slice(PREFIX.length) : base;
}

export class OmpVersionError extends Error {
  readonly code = 'omp-version-failed';

  constructor(message: string) {
    super(message);
    this.name = 'OmpVersionError';
  }
}

/** Raised when a detached parent aborts startup before ownership is published. */
export class StartupAbortedError extends Error {
  constructor() {
    super('ux-e2e: detached startup aborted');
    this.name = 'StartupAbortedError';
  }
}
/** Startup failed after PTY ownership was published; retry through session.json. */
export class StartupRecoveryError extends Error {
  readonly code = 'startup-recovery-required';
  readonly recoveryPath: string;
  constructor(recoveryPath: string, message: string) {
    super(`${message}; retry authenticated stop using ${recoveryPath}`);
    this.name = 'StartupRecoveryError';
    this.recoveryPath = recoveryPath;
  }
}

const MAX_VERSION_OUTPUT_BYTES = 4096;
/**
 * The real omp CLI currently starts in well under one second on the validation
 * host. Keep a bounded 15s allowance for a busy event loop (the dispatcher
 * performs descriptor-safe filesystem work), while never allowing a probe to
 * run indefinitely.
 */
const VERSION_PROBE_TIMEOUT_MS = 15_000;
const VERSION_PROBE_KILL_GRACE_MS = 250;
const VERSION_PROBE_CACHE = new Map<string, Promise<string>>();

interface VersionProbeOwner {
  readonly onSpawn?: (owner: { readonly pid: number; readonly pgid: number; readonly startIdentity: string | null }) => void;
  readonly onClose?: () => void;
}

type VersionProbeChild = import('node:child_process').ChildProcess;

const VERSION_PROBE_CLOSE_TIMEOUT_MS = 45_000;
// A browser may never answer a WebSocket close handshake. Keep shutdown
// bounded well below the CLI stop SLA, then terminate only those exact sockets
// still owned by this session.
const WS_CLOSE_GRACE_MS = 750;
const WS_CLOSE_FORCE_WAIT_MS = 750;

async function closeWebSocketServer(wss: WebSocketServer): Promise<void> {
  let closed = false;
  let resolveClosed: (() => void) | null = null;
  const allClosed = new Promise<void>(resolve => { resolveClosed = resolve; });
  for (const ws of wss.clients) {
    try { ws.close(1001, 'server shutting down'); } catch { /* already closing */ }
  }
  try {
    wss.close(() => {
      closed = true;
      resolveClosed?.();
    });
  } catch (error) {
    // A retry after a completed close can observe an already-closed WSS;
    // with no clients left there is no ownership left to drain.
    if (wss.clients.size === 0) return;
    throw error;
  }
  let graceTimer: NodeJS.Timeout | undefined;
  const graceful = await Promise.race([
    allClosed.then(() => true),
    new Promise<boolean>(resolve => {
      graceTimer = setTimeout(() => resolve(false), WS_CLOSE_GRACE_MS);
      graceTimer.unref?.();
    }),
  ]);
  clearTimeout(graceTimer);
  if (graceful || closed) return;
  // The graceful deadline expired. Terminate only the authenticated WSS
  // clients that are still present; never signal a numeric process owner.
  for (const ws of wss.clients) {
    try { ws.terminate(); } catch { /* already closing */ }
  }
  let forceTimer: NodeJS.Timeout | undefined;
  const forced = await Promise.race([
    allClosed.then(() => true),
    new Promise<boolean>(resolve => {
      forceTimer = setTimeout(() => resolve(false), WS_CLOSE_FORCE_WAIT_MS);
      forceTimer.unref?.();
    }),
  ]);
  clearTimeout(forceTimer);
  if (!forced && !closed) {
    throw new Error('ux-e2e: WebSocket clients did not close within bounded shutdown grace');
  }
}

const HTTP_CLOSE_TIMEOUT_MS = 1_500;

async function closeHttpServer(server: Server, trackedSockets?: Set<import('node:net').Socket>): Promise<void> {
  if (!server.listening) {
    for (const socket of trackedSockets ?? []) socket.destroy();
    return;
  }
  let closed = false;
  let closeError: Error | undefined;
  const complete = new Promise<void>(resolve => {
    server.close(error => {
      closeError = error;
      closed = true;
      resolve();
    });
  });
  let timer: NodeJS.Timeout | undefined;
  const graceful = await Promise.race([
    complete.then(() => true),
    new Promise<boolean>(resolve => {
      timer = setTimeout(() => resolve(false), HTTP_CLOSE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
  clearTimeout(timer);
  if (!graceful && !closed) {
    // closeAllConnections excludes upgraded sockets; those were drained by
    // closeWebSocketServer before this listener helper runs. Destroy the
    // tracked sockets too so incomplete parsers cannot hold the listener open.
    server.closeAllConnections();
    for (const socket of trackedSockets ?? []) socket.destroy();
    let forceTimer: NodeJS.Timeout | undefined;
    const forced = await Promise.race([
      complete.then(() => true),
      new Promise<boolean>(resolve => {
        forceTimer = setTimeout(() => resolve(false), HTTP_CLOSE_TIMEOUT_MS);
        forceTimer.unref?.();
      }),
    ]);
    clearTimeout(forceTimer);
    if (!forced && !closed) throw new Error('ux-e2e: HTTP listener did not close within bounded shutdown grace');
  }
  if (closeError !== undefined) throw closeError;
}

async function waitForVersionProbeClose(child: VersionProbeChild, closed: Promise<void>, startIdentity: string | null, pgid: number | null): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (startIdentity === null || !signalOwnedGroup(child.pid ?? null, pgid, startIdentity)) {
    throw new OmpVersionError('omp --version cleanup refused: owned process group identity changed');
  }
  const closedInBound = await Promise.race([
    closed.then(() => true),
    new Promise<boolean>(resolve => {
      const timer = setTimeout(() => resolve(false), VERSION_PROBE_CLOSE_TIMEOUT_MS);
      timer.unref?.();
    }),
  ]);
  if (!closedInBound) {
    throw new OmpVersionError('omp --version child did not close within ' + String(VERSION_PROBE_CLOSE_TIMEOUT_MS) + 'ms after SIGTERM');
  }
}

async function probeOmpVersion(binary: string, owner: VersionProbeOwner = {}): Promise<string> {
  let child: VersionProbeChild | null = null;
  let closed = Promise.resolve();
  let childStartIdentity: string | null = null;
  let childPgid: number | null = null;
  let childClosedObserved = false;
  let ownerCloseNotified = false;
  const notifyOwnerClose = (): void => {
    if (ownerCloseNotified) return;
    ownerCloseNotified = true;
    owner.onClose?.();
  };
  let settled = false;
  let timeout: NodeJS.Timeout | undefined;
  let output = '';
  let outputBytes = 0;
  try {
    const { promise, resolve: done, reject: fail } = deferred<string>();
    // A spawn error can be emitted after this function has already failed
    // before reaching the normal await. Keep the deferred rejection handled.
    void promise.catch(() => undefined);
    const rejectOnce = (error: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      fail(error);
    };
    child = spawn(binary, ['--version'], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const spawnedChild = child;
    // Install ownership listeners before inspecting pid or doing any other
    // synchronous work: missing/unspawnable binaries must never emit an
    // unhandled ChildProcess 'error'.
    closed = new Promise<void>(resolve => spawnedChild.once('close', () => {
      childClosedObserved = true;
      // Notify at the event itself, not only from finally: a probe whose
      // identity was unknown may outlive the rejected startup promise.
      notifyOwnerClose();
      resolve();
    }));
    spawnedChild.once('error', error => {
      rejectOnce(new OmpVersionError('omp --version failed: ' + error.message));
    });
    spawnedChild.once('close', code => {
      clearTimeout(timeout);
      if (settled) return;
      if (code !== 0) {
        rejectOnce(new OmpVersionError('omp --version exited with code ' + String(code)));
        return;
      }
      settled = true;
      done(output);
    });
    const childPid = spawnedChild.pid;
    if (childPid === undefined) {
      // No owner was publishable. Prevent a later asynchronous spawn error
      // from rejecting an otherwise-unobserved deferred promise.
      settled = true;
      throw new OmpVersionError('omp --version did not expose a child pid');
    }
    childStartIdentity = captureProbeStartIdentity(childPid);
    childPgid = processGroupId(childPid) ?? childPid;
    owner.onSpawn?.({ pid: childPid, pgid: childPgid, startIdentity: childStartIdentity });
    const terminate = (error: Error): void => {
      rejectOnce(error);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
    };
    const consume = (chunk: Buffer): void => {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_VERSION_OUTPUT_BYTES) {
        terminate(new OmpVersionError(
          'omp --version output exceeded ' + String(MAX_VERSION_OUTPUT_BYTES) + ' bytes',
        ));
        return;
      }
      output += chunk.toString('utf8');
    };
    child.stdout?.on('data', consume);
    // Drain stderr too so a noisy probe cannot block on a full pipe.
    child.stderr?.on('data', consume);
    timeout = setTimeout(() => {
      terminate(new OmpVersionError('omp --version exceeded ' + String(VERSION_PROBE_TIMEOUT_MS) + 'ms'));
    }, VERSION_PROBE_TIMEOUT_MS);
    const stdout = await promise;
    const first = stdout.trim().split('\n')[0];
    if (first !== undefined && first.length > 0) return first;
    return 'unknown';
  } catch (error) {
    if (error instanceof OmpVersionError) throw error;
    return 'unknown';
  } finally {
    if (child !== null) {
      try {
        await waitForVersionProbeClose(child, closed, childStartIdentity, childPgid);
      } finally {
        if (childClosedObserved) notifyOwnerClose();
      }
    }
  }
}

function resolveOmpVersion(binary: string, owner: VersionProbeOwner = {}): Promise<string> {
  const cached = VERSION_PROBE_CACHE.get(binary);
  if (cached !== undefined) return cached;
  const probe = probeOmpVersion(binary, owner);
  VERSION_PROBE_CACHE.set(binary, probe);
  void probe.catch(() => {
    if (VERSION_PROBE_CACHE.get(binary) === probe) VERSION_PROBE_CACHE.delete(binary);
  });
  return probe;
}

function stateDirOf(scratchDir: string): string {
  return join(scratchDir, '.work-state', 'ux-e2e');
}
/**
 * Ensure node-pty's Darwin helper is executable before the native spawn path
 * is used. Some package managers preserve the helper as 0644 even though it
 * is a Mach-O executable; node-pty then reports only `posix_spawnp failed`.
 * Candidate paths are constrained to node-pty's own package directory so a
 * malformed package cannot make the harness chmod an arbitrary file.
 */
/**
 * Keep the OMP process' ambient home isolated from ~/.omp/plugins. The host
 * agent directory is symlinked into the isolated home so auth/model/session
 * state remains available while legacy extension shims cannot discover stale
 * user plugins. Explicit --config and --extension remain the source of truth.
 */
function prepareOmpIsolationHome(scratchDir: string): { readonly home: string; readonly agentDir: string } {
  const home = join(stateDirOf(scratchDir), 'omp-home');
  const ompDir = join(home, '.omp');
  const agentDir = join(ompDir, 'agent');
  mkdirSync(ompDir, { recursive: true, mode: SESSION_DIR_MODE });
  const hostOmpDir = join(homedir(), '.omp');
  try {
    for (const entry of readdirSync(hostOmpDir, { withFileTypes: true })) {
      // Host runtime secrets are root-bound credentials. They must never be
      // inherited by symlink: the isolated HOME needs its own private store.
      // Plugins are also deliberately excluded so legacy extension discovery
      // cannot observe stale host state.
      if (entry.name === 'plugins' || entry.name === 'runtime-secrets') continue;
      const source = join(hostOmpDir, entry.name);
      const target = join(ompDir, entry.name);
      if (existsSync(target)) continue;
      symlinkSync(source, target, entry.isDirectory() ? 'dir' : 'file');
    }
    const runtimeSecretsDir = join(ompDir, 'runtime-secrets');
    mkdirSync(runtimeSecretsDir, { recursive: true, mode: SESSION_DIR_MODE });
    const runtimeSecretsInfo = lstatSync(runtimeSecretsDir);
    if (runtimeSecretsInfo.isSymbolicLink() || !runtimeSecretsInfo.isDirectory()) {
      throw new Error('runtime-secrets isolation target must be a regular directory');
    }
    chmodSync(runtimeSecretsDir, SESSION_DIR_MODE);
    if (!existsSync(agentDir)) {
      symlinkSync(join(hostOmpDir, 'agent'), agentDir, 'dir');
    }
  } catch (error) {
    throw new Error(`ux-e2e: cannot isolate OMP home: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { home, agentDir };
}

function ensureDarwinPtyHelperExecutable(): void {
  if (process.platform !== 'darwin') return;
  let packageRoot: string;
  try {
    packageRoot = dirname(require.resolve('node-pty/package.json'));
  } catch (err) {
    throw new Error(`ux-e2e: cannot locate node-pty package: ${err instanceof Error ? err.message : String(err)}`);
  }
  const targetDir = `${process.platform}-${process.arch}`;
  const helperCandidates = ['build/Release', 'build/Debug', `prebuilds/${targetDir}`];
  let helper: string | null = null;
  for (const relativeDir of helperCandidates) {
    const candidate = join(packageRoot, relativeDir, 'spawn-helper');
    try {
      if (lstatSync(candidate).isFile()) {
        helper = candidate;
        break;
      }
    } catch {
      // Try the next node-pty native artifact location.
    }
  }
  if (helper === null) throw new Error(`ux-e2e: node-pty ${targetDir}/spawn-helper is missing`);
  try {
    const packageReal = realpathSync(packageRoot);
    const helperStat = lstatSync(helper);
    if (!helperStat.isFile()) throw new Error('spawn-helper is not a regular file');
    const helperReal = realpathSync(helper);
    if (!helperReal.startsWith(`${packageReal}/`) || basename(helperReal) !== 'spawn-helper') {
      throw new Error('spawn-helper resolves outside node-pty package');
    }
    // Preserve read/write bits; only add the executable bits required by posix_spawnp.
    const currentMode = helperStat.mode & 0o777;
    const executableMode = currentMode | 0o111;
    if (currentMode !== executableMode) chmodSync(helperReal, executableMode);
    if ((lstatSync(helperReal).mode & 0o111) === 0) throw new Error('spawn-helper remains non-executable');
  } catch (err) {
    throw new Error(`ux-e2e: cannot prepare node-pty ${targetDir}/spawn-helper: ${err instanceof Error ? err.message : String(err)}`);
  }
}
/**
 * Start a test session under the same parent-directory admission lock used
 * by bootstrap. The lock spans stale-state validation through publication.
 */
export const UX_E2E_ADMISSION_LOCK = '.ux-e2e-admission.lock';

export async function startTestSession(opts: TestSessionOptions): Promise<TestSession> {
  if (typeof opts.cwd !== 'string' || opts.cwd.length === 0) {
    throw new Error('ux-e2e: startTestSession requires a cwd (scratch project directory)');
  }
  const scratchDir = resolve(opts.cwd);
  const parentRoot = pinDirectory(dirname(scratchDir));
  if (parentRoot === null) throw new Error('ux-e2e: unsafe session admission parent directory');
  try {
    return await withPinnedExclusiveLockAsync(
      parentRoot,
      UX_E2E_ADMISSION_LOCK,
      () => startTestSessionUnlocked(opts),
      10_000,
    );
  } finally {
    closePinnedDirectory(parentRoot);
  }
}

async function startTestSessionUnlocked(opts: TestSessionOptions): Promise<TestSession> {
  if (opts.startupAbortSignal?.aborted) throw new StartupAbortedError();
  if (typeof opts.cwd !== 'string' || opts.cwd.length === 0) {
    throw new Error('ux-e2e: startTestSession requires a cwd (scratch project directory)');
  }
  const host = '127.0.0.1';
  const publicHost = host;
  const scratchDir = resolve(opts.cwd);
  const runtimeExtensionPath = runtimeExtensionPackagePath(scratchDir);
  assertNoLiveSession(scratchDir, false);
  const surface = opts.surface ?? 'web';
  const cols = opts.cols ?? 100;
  const rows = opts.rows ?? 30;
  const idleMs = opts.idleMs ?? 1_200_000;
  const rateLimit: Required<RateLimitOptions> = {
    maxMessages: opts.rateLimit?.maxMessages ?? 200,
    windowMs: opts.rateLimit?.windowMs ?? 1000,
  };
  const ompBinary = opts.ompBinary ?? process.env['OMP_BIN'] ?? 'omp';
  // Default: NO --profile flag. omp inherits the host default profile
  // (`~/.omp/agent/`) — `modelRoles`, `models.db`, credentials all
  // resolve there. Explicit `ompProfile` keeps the run isolated; the
  // caller opts in.
  const ompProfile = opts.ompProfile;
  const maxTimeSec = opts.maxTimeSec ?? 1800;
  const approvalMode = opts.approvalMode ?? 'yolo';
  const token = opts.token ?? mintToken();
  const bootstrapCode = mintToken();
  const bootstrapExpiresAt = Date.now() + 60_000;
  const serverStartIdentity = processStartIdentity(process.pid);
  if (serverStartIdentity === null) {
    throw new Error('ux-e2e: unable to capture server process identity');
  }
  const sessionId = mintToken();
  const controlNonce = mintToken();
  const serverStartNonce = opts.serverStartNonce ?? mintToken();
  if (boundedSessionString(serverStartNonce, 256) === null) {
    throw new Error('ux-e2e: invalid detached-start nonce');
  }
  const startedAt = new Date().toISOString();

  const stateDir = stateDirOf(scratchDir);
  const stateRoot = pinOrCreateDirectory(stateDir);
  if (stateRoot === null) {
    throw new Error('ux-e2e: session directory must be a stable non-symlink directory');
  }
  let stateRootClosed = false;
  const closeStateRoot = (): void => {
    if (stateRootClosed) return;
    stateRootClosed = true;
    closePinnedDirectory(stateRoot);
  };
  const transcriptPath = join(stateDir, 'transcript.jsonl');
  const sessionJsonPath = join(stateDir, 'session.json');
  // Truncate through the retained directory descriptor. A hardlink or
  // symlink at the destination is replaced atomically without touching its
  // target.
  if (!writePinnedFile(stateRoot, 'transcript.jsonl', Buffer.alloc(0))) {
    closeStateRoot();
    throw new Error('ux-e2e: failed to initialize pinned transcript');
  }

  if (opts.startupAbortSignal?.aborted) {
    closeStateRoot();
    throw new StartupAbortedError();
  }
  // Materialize the exact overlay passed below before any OMP startup.
  let configPath: string;
  try {
    configPath = writeUxE2eOverlay(scratchDir);
  } catch (error) {
    closeStateRoot();
    throw error;
  }
  const userConfigDefaultPath = join(scratchDir, '.omp', 'ux-e2e-overlay.user.json');
  const userConfigRoot = pinDirectory(join(scratchDir, '.omp'));
  let userConfigPath: string | null = null;
  if (userConfigRoot !== null) {
    try {
      if (readPinnedFileFull(userConfigRoot, basename(userConfigDefaultPath), 8 * 1024 * 1024) !== null) {
        userConfigPath = userConfigDefaultPath;
      }
    } finally {
      closePinnedDirectory(userConfigRoot);
    }
  }


  if (opts.startupAbortSignal?.aborted) {
    closeStateRoot();
    throw new StartupAbortedError();
  }

  let ompVersion: string;

  // Reserve an authenticated recovery listener and publish ownership before
  // the version probe creates any child. The real HTTP server is created after
  // the probe succeeds; this listener exists solely so a failed/stubborn probe
  // remains controllable through the same bearer + nonce + session identity.
  const probeRecoveryServer: Server = createServer();
  const probeRecoveryWss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_WS_BYTES });
  const probeRecoveryBound = deferred<void>();
  probeRecoveryServer.once('error', probeRecoveryBound.reject);
  probeRecoveryServer.listen(opts.port ?? 0, host, () => probeRecoveryBound.resolve());
  probeRecoveryServer.unref();
  try {
    await probeRecoveryBound.promise;
  } catch (error) {
    closeStateRoot();
    throw error;
  }
  const probeRecoveryAddress = probeRecoveryServer.address();
  if (probeRecoveryAddress === null || typeof probeRecoveryAddress === 'string') {
    closeStateRoot();
    throw new Error('ux-e2e: failed to resolve startup recovery port');
  }
  const probeRecoveryOrigin = `http://${publicHost}:${probeRecoveryAddress.port}`;
  const probeRecoveryUrl = `${probeRecoveryOrigin}/?token=${encodeURIComponent(token)}`;
  const probeRecoveryBrowserUrl = `${probeRecoveryOrigin}/?code=${encodeURIComponent(bootstrapCode)}`;
  let probeOwner: { pid: number; pgid: number; startIdentity: string | null } | null = null;
  let resolveProbeClosed: (() => void) | null = null;
  let probeClosedObserved = false;
  const probeClosed = new Promise<void>(resolve => { resolveProbeClosed = resolve; });
  let probeRecoveryMetadata: Record<string, unknown> = {
    schema_version: 2,
    session_id: sessionId,
    control_nonce: controlNonce,
    server_pid: process.pid,
    server_start_identity: serverStartIdentity,
    server_start_nonce: serverStartNonce,
    slug: deriveSlug(scratchDir),
    url: probeRecoveryUrl,
    browser_url: probeRecoveryBrowserUrl,
    browser_bootstrap_consumed: false,
    browser_code_expires_at: new Date(bootstrapExpiresAt).toISOString(),
    token,
    wsPath: '/ws',
    omp_version: null,
    pid: null,
    pgid: null,
    probe_pid: null,
    probe_pgid: null,
    probe_start_identity: null,
    pty_start_identity: null,
    spawn_error: null,
    started_at: startedAt,
    status: 'starting' as const,
    phase: 'probing',
    shutdown_error: null,
    pty_exit_observed: false,
    shutdown_completed_at: null,
    stopped_at: null,
    finished_at: null,
  };
  const writeProbeRecovery = (patch: Record<string, unknown>): boolean => {
    const next = { ...probeRecoveryMetadata, ...patch };
    if (!writePinnedFile(stateRoot, 'session.json', Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8'))) return false;
    probeRecoveryMetadata = next;
    return true;
  };
  if (!writePinnedFile(stateRoot, 'session.json', Buffer.from(JSON.stringify(probeRecoveryMetadata, null, 2) + '\n', 'utf8'))) {
    await new Promise<void>(done => probeRecoveryServer.close(() => done()));
    closeStateRoot();
    throw new Error('ux-e2e: failed to publish authenticated startup recovery metadata');
  }
  let probeRecoveryRetained = false;
  let probeRecoveryFinalizePromise: Promise<void> | null = null;
  const convergeProbeRecovery = (): Promise<void> => {
    if (probeRecoveryFinalizePromise !== null) return probeRecoveryFinalizePromise;
    const finish = async (): Promise<void> => {
      const stoppedAt = new Date().toISOString();
      const written = writeProbeRecovery({
        // A failed probe has no version to publish, but a terminal recovery
        // record must still satisfy the v2 reader so a later start can proceed.
        omp_version: probeRecoveryMetadata['omp_version'],
        pid: null,
        pgid: null,
        probe_pid: null,
        probe_pgid: null,
        probe_start_identity: null,
        phase: 'stopped',
        status: 'stopped',
        pty_exit_observed: true,
        shutdown_error: null,
        shutdown_completed_at: stoppedAt,
        stopped_at: stoppedAt,
        finished_at: stoppedAt,
      });
      if (!written) throw new StartupRecoveryError(sessionJsonPath, 'unable to persist terminal startup probe metadata');
      try {
        await new Promise<void>(done => {
          if (!probeRecoveryServer.listening) {
            done();
            return;
          }
          probeRecoveryServer.close(() => done());
        });
      } finally {
        closeStateRoot();
      }
    };
    probeRecoveryFinalizePromise = finish();
    return probeRecoveryFinalizePromise;
  };
  const stopProbeRecovery = async (): Promise<void> => {
    if (probeRecoveryFinalizePromise !== null) return probeRecoveryFinalizePromise;
    const owner = probeOwner as { readonly pid: number; readonly pgid: number; readonly startIdentity: string | null } | null;
    if (owner !== null && !probeClosedObserved) {
      // A missing generation is unknown, not dead. Never signal by numeric
      // pid/group or via the ChildProcess handle without exact identity.
      if (owner.startIdentity === null) {
        probeRecoveryRetained = true;
        writeProbeRecovery({ status: 'shutdown_failed', phase: 'shutdown_failed', shutdown_error: 'startup probe owner identity unavailable; refusing unsafe signal' });
        throw new StartupRecoveryError(sessionJsonPath, 'startup probe owner identity unavailable; refusing unsafe signal');
      }
      if (!pidIsLive(owner.pid, owner.startIdentity)) {
        probeRecoveryRetained = true;
        writeProbeRecovery({ status: 'shutdown_failed', phase: 'shutdown_failed', shutdown_error: 'startup probe close could not be proven' });
        throw new StartupRecoveryError(sessionJsonPath, 'startup probe close could not be proven');
      }
      if (!signalOwnedGroup(owner.pid, owner.pgid, owner.startIdentity)) {
        probeRecoveryRetained = true;
        writeProbeRecovery({ status: 'shutdown_failed', phase: 'shutdown_failed', shutdown_error: 'startup probe owner identity changed' });
        throw new StartupRecoveryError(sessionJsonPath, 'startup probe owner identity changed');
      }
      const exited = await Promise.race([
        probeClosed.then(() => true),
        new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false), 5_000); timer.unref?.(); }),
      ]);
      if (!exited) {
        probeRecoveryRetained = true;
        writeProbeRecovery({ status: 'shutdown_failed', phase: 'shutdown_failed', shutdown_error: 'startup probe graceful exit could not be proven' });
        throw new StartupRecoveryError(sessionJsonPath, 'startup probe graceful exit could not be proven');
      }
    }
    return convergeProbeRecovery();
  };
  probeRecoveryServer.on('request', (req, res) => {
    if (pathnameOf(req) !== '/control/stop') return;
    const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
    const nonce = typeof req.headers['x-ux-e2e-nonce'] === 'string' ? req.headers['x-ux-e2e-nonce'] : '';
    const suppliedSessionId = typeof req.headers['x-ux-e2e-session-id'] === 'string' ? req.headers['x-ux-e2e-session-id'] : '';
    if (req.method !== 'POST' || !safeEqual(authorization, `Bearer ${token}`) || !safeEqual(nonce, controlNonce) || !safeEqual(suppliedSessionId, sessionId)) {
      res.statusCode = 401;
      res.end('unauthorized');
      return;
    }
    res.statusCode = 202;
    res.once('finish', () => { void stopProbeRecovery().catch(error => process.stderr.write(`ux-e2e: startup recovery stop failed: ${sanitizeServerText(error)}\n`)); });
    res.end('stopping');
  });
  try {
    if (opts.startupAbortSignal?.aborted) throw new StartupAbortedError();
    writeProbeRecovery({ phase: 'probing', status: 'starting' });
    ompVersion = await resolveOmpVersion(ompBinary, {
      onSpawn: owner => {
        probeOwner = owner;
        if (!writeProbeRecovery({ pid: owner.pid, pgid: owner.pgid, probe_pid: owner.pid, probe_pgid: owner.pgid, probe_start_identity: owner.startIdentity, phase: 'probing' })) {
          throw new OmpVersionError('ux-e2e: failed to persist version probe owner');
        }
      },
      onClose: () => {
        probeClosedObserved = true;
        resolveProbeClosed?.();
        // Once startup has handed the recovery record back to the caller, a
        // natural child close is the authoritative terminal proof. Converge
        // the record and retire the listener asynchronously so a later start
        // cannot inherit a stale probe owner.
        if (probeRecoveryRetained) {
          void convergeProbeRecovery().catch(error => {
            process.stderr.write('ux-e2e: startup probe convergence failed: ' + sanitizeServerText(error) + '\n');
          });
        }
      },
    });
  } catch (error) {
    const owner = probeOwner as { readonly pid: number; readonly pgid: number; readonly startIdentity: string | null } | null;
    if (!probeClosedObserved && owner !== null) {
      probeClosedObserved = await Promise.race([
        probeClosed.then(() => true),
        new Promise<boolean>(resolve => { const timer = setTimeout(() => resolve(false), 250); timer.unref?.(); }),
      ]);
    }
    if (owner !== null && !probeClosedObserved) {
      // The owner is still live or unknown. In particular, a null generation
      // MUST NOT be collapsed into pidIsLive(..., null): retain the
      // authenticated listener and metadata for an exact-identity stop.
      probeRecoveryRetained = true;
      writeProbeRecovery({ status: 'shutdown_failed', phase: 'shutdown_failed', shutdown_error: sanitizeServerText(error) });
      throw new StartupRecoveryError(sessionJsonPath, sanitizeServerText(error));
    }
    // No owner was published (for example, a missing/unspawnable binary).
    // Persist the terminal proof through the pinned descriptor before closing
    // it; leaving the prepublished starting record would block every retry.
    await convergeProbeRecovery();
    throw error;
  }
  await new Promise<void>(done => probeRecoveryServer.close(() => done()));
  if (opts.startupAbortSignal?.aborted) {
    unlinkPinnedFile(stateRoot, 'session.json');
    closeStateRoot();
    throw new StartupAbortedError();
  }
  // The probe owner is gone and its temporary recovery listener is closed;
  // the normal server below publishes the concrete OMP version and continues.
  if (opts.startupAbortSignal?.aborted) {
    closeStateRoot();
    throw new StartupAbortedError();
  }

  const httpServer: Server = createServer();
  const httpSockets = new Set<import('node:net').Socket>();
  httpServer.on('connection', socket => {
    httpSockets.add(socket);
    socket.once('close', () => httpSockets.delete(socket));
  });
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_WS_BYTES });
  let ptyProc: IPty | null = null;
  let ptyExited = true;
  let ptyExitEvent: { readonly exitCode: number; readonly signal?: number } | null = null;
  let ptyStartIdentity: string | null = null;
  let resolvePtyExit: (() => void) | null = null;
  const ptyExit = new Promise<void>(resolve => { resolvePtyExit = resolve; });
  let recoveryMetadata: Record<string, unknown> | null = null;
  let sessionMetadataPublished = false;
  const publishRecoveryPatch = (patch: Record<string, unknown>): boolean => {
    if (recoveryMetadata === null) return false;
    const next = { ...recoveryMetadata, ...patch };
    if (!writePinnedFile(stateRoot, 'session.json', Buffer.from(JSON.stringify(next, null, 2) + '\n', 'utf8'))) return false;
    recoveryMetadata = next;
    return true;
  };
  const publishRecoveryStatus = (status: 'starting' | 'running' | 'shutdown_failed' | 'stopped', error?: unknown): boolean => (
    publishRecoveryPatch({
      status,
      shutdown_error: error === undefined ? null : sanitizeServerText(error),
    })
  );
  const rollbackStartup = async (): Promise<void> => {
    let retainRecovery = false;
    try {
      if (ptyProc !== null && !ptyExited) {
        const ownerPgid = typeof recoveryMetadata?.pgid === 'number' ? recoveryMetadata.pgid : processGroupId(ptyProc.pid);
        const ownerStart = ptyStartIdentity;
        if (ownerStart === null) {
          const published = publishRecoveryStatus('shutdown_failed', 'startup rollback cannot safely signal PTY without captured identity');
          retainRecovery = sessionMetadataPublished && published;
          throw new StartupRecoveryError(sessionJsonPath, 'startup rollback cannot safely signal PTY without captured identity');
        } else if (!signalOwnedGroup(ptyProc.pid, ownerPgid, ownerStart)) {
          const published = publishRecoveryStatus('shutdown_failed', 'startup rollback could not authenticate the PTY process group');
          retainRecovery = sessionMetadataPublished && published;
          throw new StartupRecoveryError(sessionJsonPath, 'startup rollback could not authenticate the PTY process group');
        }
        const timeoutMs = 5_000;
        let timer: NodeJS.Timeout | undefined;
        const exited = await Promise.race([
          ptyExit.then(() => true),
          new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), timeoutMs); }),
        ]);
        clearTimeout(timer);
        if (!exited) {
          const published = publishRecoveryStatus('shutdown_failed', 'startup rollback could not prove graceful PTY exit');
          retainRecovery = sessionMetadataPublished && published;
          process.stderr.write(`ux-e2e: startup rollback could not prove graceful PTY exit; ${retainRecovery ? 'authenticated recovery retained' : 'recovery unavailable'}\n`);
          throw new StartupRecoveryError(sessionJsonPath, 'startup rollback could not prove graceful PTY exit');
        }
      }
      await closeWebSocketServer(wss);
      await closeHttpServer(httpServer, httpSockets);
    } catch (error) {
      // Never publish a terminal record while a listener cleanup helper has
      // failed. Retain authenticated recovery so a later stop can retry the
      // still-bound server instead of allowing a fixed-port collision.
      const published = publishRecoveryStatus('shutdown_failed', error);
      retainRecovery = sessionMetadataPublished && published;
      throw error;
    } finally {
      if (!retainRecovery) {
        // All owned children and listeners have closed here. If this rollback
        // had already published a session record, converge it to terminal
        // proof before releasing the pinned descriptor so a retry is allowed.
        if (sessionMetadataPublished && recoveryMetadata !== null) {
          const stoppedAt = new Date().toISOString();
          publishRecoveryPatch({
            pid: null,
            pgid: null,
            probe_pid: null,
            probe_pgid: null,
            probe_start_identity: null,
            phase: 'stopped',
            status: 'stopped',
            pty_exit_observed: true,
            shutdown_error: null,
            shutdown_completed_at: stoppedAt,
            stopped_at: stoppedAt,
            finished_at: stoppedAt,
          });
        }
        closeStateRoot();
      }
    }
  };
  let assets: VendorAssets;
  try {
    assets = resolveVendorAssets();
  } catch (error) {
    await rollbackStartup();
    throw error;
  }
  // The server is intentionally created before spawning so every post-spawn
  // failure has a listener and an authenticated coordinator available.
  // The 256-bit bearer token is session-scoped: localhost and origin checks
  // constrain its use, and reconnects remain possible until shutdown.

  const { promise: listening, resolve: bound, reject: bindFailed } = deferred<void>();
  httpServer.once('error', bindFailed);
  httpServer.listen(opts.port ?? 0, host, () => bound());
  try {
    await listening;
  } catch (error) {
    await rollbackStartup();
    throw error;
  }

  if (opts.startupAbortSignal?.aborted) {
    await rollbackStartup();
    throw new StartupAbortedError();
  }
  const addr = httpServer.address();
  if (addr === null || typeof addr === 'string') {
    await rollbackStartup();
    throw new Error('ux-e2e: failed to resolve bound port');
  }
  const boundPort = addr.port;
  const origin = `http://${publicHost}:${boundPort}`;
  const wsPath = '/ws';
  const browserUrl = `http://${publicHost}:${boundPort}/?code=${encodeURIComponent(bootstrapCode)}`;
  const url = `http://${publicHost}:${boundPort}/?token=${encodeURIComponent(token)}`;
  // Resolve the host omp config FIRST so the warning is in session.json
  // (and stderr) regardless of noPty mode. omp merges `--config` overlays
  // in argv order — putting the host config before the ux-e2e overlay
  // means the overlay (later) wins for keys it explicitly sets, and the
  // host's `modelRoles` (and any other untouched keys) survive. Without
  // the host config, omp boots with "No model selected".
  const hostConfig = checkHostOmpConfig();
  if (hostConfig.warning !== null) {
    process.stderr.write(`ux-e2e: WARNING: ${hostConfig.warning}\n`);
  }
  // Operator-supplied overlay (opt-in): present-when-exists at
  // `<scratch>/.omp/ux-e2e-overlay.user.json`. When found, it is emitted
  // as the THIRD `--config` (after host config and the regenerated
  // ux-e2e overlay) so its keys win on conflict — letting a test run
  // pin `modelRoles` (or anything else) without touching the host
  // config. Absence is the normal case.
  // Capture the package identities before OMP starts. A real runtime scratch
  // must resolve exactly one workspace-linked fullstack/core pair; absent
  // packages are retained only for noPty/unit-test sessions.
  // Publish the authenticated owner before node-pty is allowed to spawn.
  // The record is deliberately complete enough for a stop/recovery attempt;
  // runtime/plugin details are patched after inspection, never before owner
  // publication.
  let ompLogBinding: Record<string, unknown> | null = null;
  let runtimePluginRegistry: RuntimePluginRegistry | null = null;
  let spawnError: string | null = null;
  let ompIsolation: { readonly home: string; readonly agentDir: string } | null = null;
  const sessionJson = {
    schema_version: 2,
    session_id: sessionId,
    control_nonce: controlNonce,
    server_pid: process.pid,
    server_start_identity: serverStartIdentity,
    server_start_nonce: serverStartNonce,
    slug: deriveSlug(scratchDir),
    url,
    browser_url: browserUrl,
    browser_bootstrap_consumed: false,
    browser_code_expires_at: new Date(bootstrapExpiresAt).toISOString(),
    token,
    wsPath,
    omp_version: ompVersion,
    pid: null as number | null,
    pgid: null as number | null,
    probe_pid: null,
    probe_pgid: null,
    probe_start_identity: null,
    pty_start_identity: null,
    spawn_error: null as string | null,
    started_at: startedAt,
    status: 'starting' as const,
    phase: 'spawning',
    shutdown_error: null as string | null,
    pty_exit_observed: false,
    shutdown_completed_at: null as string | null,
    stopped_at: null as string | null,
    finished_at: null as string | null,
    profile: ompProfile ?? null,
    tty: { cols, rows, term: 'xterm-256color' },
    task_prompt: opts.taskPrompt !== null && opts.taskPrompt !== undefined ? sanitizeForJson(opts.taskPrompt) : null,
    scenario: opts.scenario ?? null,
    surface,
    host_config: {
      path: hostConfig.path,
      warning: hostConfig.warning,
    },
    omp_log_binding: null,
    user_config: {
      path: userConfigPath,
      default_path: userConfigDefaultPath,
    },
    extension_isolation: {
      ambient_discovery_disabled: true,
      explicit_roots: runtimeExtensionPath,
      home: null,
      agent_dir: null,
    },
    runtime_plugins: null,
  };
  recoveryMetadata = sessionJson;
  if (!writePinnedFile(stateRoot, 'session.json', Buffer.from(JSON.stringify(sessionJson, null, 2) + '\n', 'utf8'))) {
    await rollbackStartup();
    throw new Error('ux-e2e: failed to write pinned session metadata before PTY spawn');
  }
  sessionMetadataPublished = true;

  try {
    if (existsSync(join(runtimeExtensionPath, 'package.json'))) {
      runtimePluginRegistry = inspectRuntimePluginRegistry(scratchDir);
    }
    if (opts.noPty !== true) {
      if (opts.startupAbortSignal?.aborted) throw new StartupAbortedError();
      ensureDarwinPtyHelperExecutable();
      const ptyMod = await import('node-pty');
      if (opts.startupAbortSignal?.aborted) throw new StartupAbortedError();
      ompIsolation = prepareOmpIsolationHome(scratchDir);
      const env = buildPtyEnv(process.env, {
        ...(opts.env ?? {}),
        HOME: ompIsolation.home,
        PI_CODING_AGENT_DIR: ompIsolation.agentDir,
      }, { keepProxyEnv: opts.keepProxyEnv });
      const args = buildOmpArgs({
        ompProfile,
        runtimeExtensionPath,
        maxTimeSec,
        approvalMode,
        configPath,
        sessionDir: join(scratchDir, '.omp', 'agent'),
        userConfigDefaultPath,
        ...(hostConfig.path !== null ? { hostConfigPath: hostConfig.path } : {}),
        ...(userConfigPath !== null ? { userConfigPath } : {}),
      });
      if (opts.startupAbortSignal?.aborted) throw new StartupAbortedError();
      try {
        ptyProc = ptyMod.spawn(ompBinary, args, { name: 'xterm-256color', cols, rows, cwd: scratchDir, env });
        ptyExited = false;
        ptyProc.onExit(({ exitCode, signal }) => {
          ptyExited = true;
          ptyExitEvent = { exitCode, ...(signal !== undefined ? { signal } : {}) };
          resolvePtyExit?.();
        });
        // Capture the process generation exactly once while the freshly
        // spawned handle is still the authoritative owner.
        ptyStartIdentity = processStartIdentity(ptyProc.pid);

      } catch (err) {
        spawnError = sanitizeServerText(err);
      }

    }
  } catch (error) {
    await rollbackStartup();
    throw error;
  }
  const isolationPatch = ompIsolation === null ? {} : {
    extension_isolation: {
      ambient_discovery_disabled: true,
      explicit_roots: runtimeExtensionPath,
      home: ompIsolation.home,
      agent_dir: ompIsolation.agentDir,
    },
  };
  if (ptyProc !== null) {
    const ptyPgid = processGroupId(ptyProc.pid) ?? ptyProc.pid;
    if (!publishRecoveryPatch({ pid: ptyProc.pid, pgid: ptyPgid, pty_start_identity: ptyStartIdentity, runtime_plugins: runtimePluginRegistry, spawn_error: spawnError, phase: 'spawning', ...isolationPatch })) {
      await rollbackStartup();
      throw new StartupRecoveryError(sessionJsonPath, 'unable to persist PTY owner metadata');
    }
  } else if (!publishRecoveryPatch({ runtime_plugins: runtimePluginRegistry, spawn_error: spawnError, phase: 'spawning', ...isolationPatch })) {
    await rollbackStartup();
    throw new Error('ux-e2e: unable to persist startup metadata');
  }
  const snapshotOmpLog = async (): Promise<Record<string, unknown> | null> => {
    const pid = ptyProc?.pid;
    if (pid === undefined || ptyStartIdentity === null) return null;
    const fallbackPath = join(homedir(), '.omp', 'logs', `omp.${startedAt.slice(0, 10)}.${String(pid)}.log`);
    const binding = ompLogBinding;
    const expectedPath = binding !== null && typeof binding.path === 'string' ? binding.path : fallbackPath;
    const deadline = Date.now() + 5_000;
    for (;;) {
      const parent = pinDirectory(dirname(expectedPath));
      if (parent !== null) {
        try {
          const info = lstatSync(expectedPath);
          const identityMatches = binding === null
            || (typeof binding.dev === 'number' && typeof binding.ino === 'number'
              && info.dev === binding.dev && info.ino === binding.ino);
          if (info.isFile() && !info.isSymbolicLink() && info.nlink === 1
            && identityMatches && info.size <= MAX_PINNED_READ_BYTES) {
            const bytes = readPinnedFileFull(parent, basename(expectedPath), MAX_PINNED_READ_BYTES);
            if (bytes !== null && bytes.length === info.size) {
              const sha256 = createHash('sha256').update(bytes).digest('hex');
              const relativePath = `omp-log.${sha256}.log`;
              if (!writePinnedFile(stateRoot, relativePath, bytes)) return null;
              return {
                relative_path: relativePath,
                size: bytes.length,
                sha256,
                source_dev: info.dev,
                source_ino: info.ino,
                generation: serverStartNonce,
                process_start: ptyStartIdentity,
              };
            }
          }
        } catch {
          /* Log creation may lag PTY exit; retry within the bounded window. */
        } finally {
          closePinnedDirectory(parent);
        }
      }
      if (Date.now() >= deadline) return null;
      await new Promise<void>(resolve => setTimeout(resolve, 50));
    }
  };
  let bootstrapConsumed = false;
  const consumeBrowserBootstrap = (req: IncomingMessage, res: ServerResponse): boolean => {
    if (bootstrapConsumed || req.url === undefined) return false;
    let code: string | null = null;
    try {
      code = new URL(req.url, origin).searchParams.get('code');
    } catch {
      return false;
    }
    if (code === null || code.length === 0 || code.length > 256 || Date.now() > bootstrapExpiresAt
      || !safeEqual(code, bootstrapCode)) return false;
    bootstrapConsumed = true;
    publishRecoveryPatch({ browser_url: null, browser_code_expires_at: null, browser_bootstrap_consumed: true });
    res.setHeader('Set-Cookie', `ux_e2e_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Strict; Path=/; Max-Age=3600`);
    return true;
  };

  let stopControl: (() => Promise<void>) | null = null;
  const observeStop = (): void => {
    const stop = stopControl;
    if (stop === null) return;
    void stop().catch(error => {
      process.stderr.write(`ux-e2e: shutdown failed: ${sanitizeServerText(error)}\n`);
    });
  };
  let stopConsumed = false;
  httpServer.on('request', (req, res) => {
    const headers = securityHeaders(publicHost, boundPort);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const path = pathnameOf(req);
    if (path === '/control/stop') {
      const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const nonce = typeof req.headers['x-ux-e2e-nonce'] === 'string' ? req.headers['x-ux-e2e-nonce'] : '';
      const suppliedSessionId = typeof req.headers['x-ux-e2e-session-id'] === 'string'
        ? req.headers['x-ux-e2e-session-id']
        : '';
      if (req.method !== 'POST' || !safeEqual(authorization, `Bearer ${token}`)
        || !safeEqual(nonce, controlNonce) || !safeEqual(suppliedSessionId, sessionId)) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      if (stopConsumed || stopControl === null) {
        res.statusCode = 409;
        res.end('session already stopping');
        return;
      }
      res.statusCode = 202;
      // Start shutdown only after Node has finished writing the response.
      // A short defer then lets clients observe the authenticated acceptance
      // before the listener begins closing.
      res.once('finish', () => {
        setTimeout(() => {
          const stop = stopControl;
          if (stop === null) return;
          void stop().then(() => {
            stopConsumed = true;
          }).catch(error => {
            process.stderr.write(`ux-e2e: shutdown failed: ${sanitizeServerText(error)}\n`);
          });
        }, 25).unref?.();
      });
      res.end('stopping');
      return;
    }
    if (path === '/session') {
      const auth = readToken(req);
      if (req.method !== 'GET' || auth === null || !safeEqual(auth.token, token)) {
        res.statusCode = 401;
        res.end('unauthorized');
        return;
      }
      res.statusCode = 200;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Cache-Control', 'no-store');
      res.end(JSON.stringify({ session_id: sessionId, ws_path: wsPath }));
      return;
    }
    if (path === '/') {
      let hasBootstrapCode = false;
      try {
        hasBootstrapCode = new URL(req.url ?? '/', origin).searchParams.has('code');
      } catch {
        hasBootstrapCode = true;
      }
      if (hasBootstrapCode && (req.method !== 'GET' || !consumeBrowserBootstrap(req, res))) {
        res.statusCode = 401;
        res.end('invalid or expired browser bootstrap code');
        return;
      }
      serveFile(res, assets.terminalHtml, 'text/html; charset=utf-8');
      return;
    }
    if (path === '/page.js') {
      serveFile(res, assets.pageJs, 'application/javascript; charset=utf-8');
      return;
    }
    if (path === '/xterm.js') {
      serveFile(res, assets.xtermJs, 'application/javascript; charset=utf-8');
      return;
    }
    if (path === '/xterm.css') {
      serveFile(res, assets.xtermCss, 'text/css; charset=utf-8');
      return;
    }
    if (path === '/addon-fit.js') {
      serveFile(res, assets.addonFitJs, 'application/javascript; charset=utf-8');
      return;
    }
    res.statusCode = 404;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.end('not found');
  });

  let closePromise: Promise<void> | null = null;
  let signalClosing = false;
  const onSignal = (): void => {
    if (signalClosing) return;
    signalClosing = true;
    observeStop();
  };
  const controller = new SessionController({
    pty: ptyProc,
    spawnError,
    idleMs,
    transcriptRoot: stateRoot,
    transcriptName: 'transcript.jsonl',
    deliveryRoot: stateRoot,
    deliveryName: 'delivery.jsonl',
    sessionId,
    ptyExitPromise: ptyExit,
    ptyPgid: typeof recoveryMetadata?.pgid === 'number' ? recoveryMetadata.pgid : null,
    ptyStartIdentity,
    ptyExited,
    onPtyExit: observeStop,
    onShutdownRequest: observeStop,

  });
  // ---- WS: authenticated upgrade -------------------------------------
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const result = attachSession(req, socket, head, wss, token, {
      origin,
      rateLimit,
      controller,
    });
    if (!result.ok) {
      const reason = result.reason;
      const status = reason === 'bad-origin' ? 403 : 401;
      socket.write(
        `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: ${reason.length}\r\n\r\n${reason}`,
      );
      socket.destroy();
    }
  });

  const rollbackHook = startupPostSpawnFailureTestHook;
  if (rollbackHook !== null) {
    let injectedFailure: Error | null;
    try {
      injectedFailure = await rollbackHook({ port: boundPort, token, origin });
    } catch (error) {
      await rollbackStartup();
      throw error;
    }
    if (injectedFailure !== null) {
      await rollbackStartup();
      throw injectedFailure;
    }
  }

  const close = async (): Promise<void> => {
    if (closePromise !== null) return closePromise;
    // A direct close() (idle/signal/test) is also a consumed shutdown
    // request. Authenticated callers must see a non-success response while
    // the listener is draining instead of reporting premature completion.
    stopConsumed = true;
    const attempt = (async (): Promise<void> => {
      // SessionController raises its admission fence before closing sockets.
      // It owns every authenticated client, so a second broadcast here would
      // only duplicate the close and delay the fence.
      // Do not retire the listener or mark metadata stopped until the exact
      // PTY exit is proven. A stubborn PTY keeps authenticated stop retryable.
      publishRecoveryPatch({ phase: 'stopping' });
      await controller.close();
      const ompLogSnapshot = await snapshotOmpLog();
      // The listener is still bound while close() drains HTTP connections.
      // Keep lifecycle metadata nonterminal until the close callback proves
      // that a fixed-port relaunch cannot collide with this server.
      const drainingPatch: Record<string, unknown> = {
        phase: 'draining',
        status: 'running',
        pty_exit_observed: false,
        shutdown_error: null,
      };
      if (ompLogSnapshot !== null) drainingPatch.omp_log_snapshot = ompLogSnapshot;
      if (ptyStartIdentity === null) drainingPatch.pid = null;
      if (!publishRecoveryPatch(drainingPatch)) {
        throw new StartupRecoveryError(sessionJsonPath, 'unable to persist shutdown drain state');
      }
      await closeWebSocketServer(wss);
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
      await closeHttpServer(httpServer, httpSockets);
      const shutdownCompletedAt = new Date().toISOString();
      if (!publishRecoveryPatch({
        phase: 'stopped',
        status: 'stopped',
        pty_exit_observed: true,
        shutdown_error: null,
        shutdown_completed_at: shutdownCompletedAt,
        stopped_at: shutdownCompletedAt,
        finished_at: shutdownCompletedAt,
      })) {
        throw new StartupRecoveryError(sessionJsonPath, 'unable to persist terminal shutdown state');
      }
      closeStateRoot();
    })();
    closePromise = attempt.catch(error => {
      publishRecoveryStatus('shutdown_failed', error);
      stopConsumed = false;
      closePromise = null;
      throw error;
    });
    return closePromise;
  };

  stopControl = close;
  if (ptyProc !== null && ptyStartIdentity === null && !ptyExited) {
    const error = 'ux-e2e: unable to capture PTY process identity';
    publishRecoveryStatus('shutdown_failed', error);
    process.stderr.write('ux-e2e: PTY identity capture failed; authenticated recovery retained\n');
    throw new StartupRecoveryError(sessionJsonPath, error);
  }
  const makeSession = (): TestSession => ({
    host,
    publicHost,
    port: boundPort,
    token,
    sessionId,
    controlNonce,
    url,
    browserUrl,
    wsPath,
    scratchDir,
    transcriptPath,
    sessionJsonPath,
    pty: {
      pid: ptyProc?.pid ?? null,
      cols,
      rows,
      mode: ptyProc !== null ? 'pty' : 'noPty',
    },
    close,
  });
  const readPtyExitEvent = (): { readonly exitCode: number; readonly signal?: number } | null => ptyExitEvent;
  const capturedPtyExit = readPtyExitEvent();
  if (capturedPtyExit !== null) {
    controller.replayPtyExit(capturedPtyExit.exitCode, capturedPtyExit.signal);
    await close();
    return makeSession();
  }
  ompLogBinding = (() => {
    const pid = ptyProc?.pid;
    if (pid === undefined || ptyStartIdentity === null) return null;
    const date = startedAt.slice(0, 10);
    const path = join(homedir(), '.omp', 'logs', `omp.${date}.${String(pid)}.log`);
    const root = pinDirectory(dirname(path));
    if (root === null) return null;
    try {
      const info = lstatSync(path);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) return null;
      const bytes = readPinnedFileFull(root, basename(path), 8 * 1024 * 1024);
      if (bytes === null || bytes.length !== info.size) return null;
      return {
        path,
        dev: info.dev,
        ino: info.ino,
        size: info.size,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        process_start: ptyStartIdentity,
        generation: serverStartNonce,
      };
    } catch {
      return null;
    } finally {
      closePinnedDirectory(root);
    }
  })();
  if (!publishRecoveryPatch({ pty_start_identity: ptyStartIdentity, omp_log_binding: ompLogBinding, phase: 'running' })) {
    process.stderr.write('ux-e2e: PTY metadata publication failed; authenticated recovery retained\n');
    throw new StartupRecoveryError(sessionJsonPath, 'unable to persist PTY process identity');
  }
  if (!publishRecoveryStatus('running')) {
    process.stderr.write('ux-e2e: running status publication failed; authenticated recovery retained\n');
    throw new StartupRecoveryError(sessionJsonPath, 'unable to persist running session status');
  }

  if (opts.startupAbortSignal?.aborted) {
    await close();
    throw new StartupAbortedError();
  }
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);

  return makeSession();
}
