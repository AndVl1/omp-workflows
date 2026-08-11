/**
 * UX E2E test server — localhost HTTP+WS bridge to a real omp PTY session.
 *
 * Hosts one HTTP+WS server on a loopback address with an ephemeral port,
 * serves a browser page (xterm) that talks to a single PTY running omp
 * with the omp-workflows plugin, and appends every PTY output frame to a
 * server-side `transcript.jsonl` — the evidence backbone for the report.
 *
 * Security posture (ported from @pi-harness/web-terminal, MIT):
 *   - session-scoped 256-bit token in `?token=` (URL-safe base64), valid only
 *     while the localhost-only session is alive;
 *   - Origin header (when present) must match the server's own origin,
 *     Host header must match exactly;
 *   - X-Frame-Options: DENY, Referrer-Policy: no-referrer, strict CSP;
 *   - per-connection rate limiter caps inbound messages per rolling window;
 *   - idle timer closes the session after no inbound traffic;
 *   - process-tree kill on shutdown (SIGTERM -> SIGKILL);
 *   - 64 KiB max inbound WS frame; no file API exposed.
 */

import { spawn } from 'node:child_process';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { IPty } from 'node-pty';
import { WebSocketServer, type WebSocket as WS } from 'ws';

import { deferred } from './util.js';
/** Max inbound WS frame size (defense-in-depth; the browser never needs more). */
export const MAX_INBOUND_WS_BYTES = 64 * 1024;
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
 * Environment values safe to carry into an OMP test PTY by default.
 *
 * OPENCODE_API_KEY and OMP_API_PROVIDER / OMP_BASE_MODEL / OMP_VISUAL_MODEL
 * are intentionally NOT listed: the AI command runner injects the API key
 * explicitly into its own session env (ai-command-runner.ts spawn site), so
 * generic e2e sessions must never inherit it (or the runner-internal override
 * names) from the parent env.
 */
export const SAFE_PTY_ENV_KEYS = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'COLORTERM',
  'NO_COLOR',
  'FORCE_COLOR',
  'CI',
] as const;

export function safePtyEnv(source: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SAFE_PTY_ENV_KEYS) {
    const value = source[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

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

function writeSessionFile(path: string, body: string): void {
  writeFileSync(path, body, { mode: SESSION_FILE_MODE });
  try {
    chmodSync(path, SESSION_FILE_MODE);
  } catch {
    /* filesystem may not support chmod (e.g. some Windows volumes) — best-effort. */
  }
}

function appendSessionFile(path: string, body: string): void {
  appendFileSync(path, body, { mode: SESSION_FILE_MODE });
  try {
    chmodSync(path, SESSION_FILE_MODE);
  } catch {
    /* best-effort. */
  }
}

/**
 * a JSON file (session.json / report). Keeps \t \n \r at the byte level
 * (they're harmless in JSON) but drops the ESC (0x1b) sequence and
 * embedded BEL/BS/VT/FF that downstream renderers can mishandle.
 */
export function sanitizeForJson(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '');
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
    this.#onIdle();
  }

  /** True if the idle timeout has already fired. */
  get fired(): boolean {
    return this.#fired;
  }
}

/* ------------------------------------------------------------------ */
/* Process-tree kill                                                   */
/* ------------------------------------------------------------------ */

export interface KillProcessTreeOptions {
  /** Time to wait between SIGTERM and SIGKILL. Default 500ms. */
  readonly graceMs?: number;
}

/**
 * Send SIGTERM to the process group `pid` (negative pid on POSIX),
 * wait `graceMs`, then SIGKILL survivors. Portable in shape; on Windows
 * `process.kill(-pid, ...)` degrades to a single-pid kill.
 */
export async function killProcessTree(pid: number, opts: KillProcessTreeOptions = {}): Promise<void> {
  const graceMs = opts.graceMs ?? 500;
  if (typeof pid !== 'number' || pid <= 0) return;

  const { promise: slept, resolve: finishSleep } = deferred<void>();
  setTimeout(finishSleep, graceMs);

  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    /* ESRCH if the group is already gone — proceed to SIGKILL. */
  }

  await slept;

  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    /* expected if the process is already dead. */
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
 * `--config` overlay order (argv order, later wins on conflict):
 *   1. `hostConfigPath` (operator's `~/.omp/agent/config.yml` when present)
 *   2. `configPath` (the regenerated ux-e2e overlay)
 *   3. `userConfigPath` (operator-supplied `<scratchDir>/.omp/ux-e2e-overlay.user.json`
 *      when present — third overlay so it overrides everything)
 */
export function buildOmpArgs(cfg: OmpLaunchConfig): string[] {
  const maxMinutes = Math.max(1, Math.round(cfg.maxTimeSec / 60));
  const args: string[] = [];
  if (typeof cfg.ompProfile === 'string' && cfg.ompProfile.length > 0) {
    args.push('--profile', cfg.ompProfile);
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
    '--max-time', `${maxMinutes}m`,
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
  if (!existsSync(path)) {
    return {
      path: null,
      warning: `host omp config not found at ${path}; omp will boot without a model. Set OMP_BIN's profile or provide ~/.omp/agent/config.yml with a 'modelRoles' block.`,
    };
  }
  let body: string;
  try {
    body = readFileSync(path, 'utf8');
  } catch (err) {
    return {
      path: null,
      warning: `host omp config at ${path} is unreadable: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
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
        warning: `host omp config at ${path} has 'modelRoles:' but no value follows; omp will boot without a model.`,
      };
    }
    // modelRoles was the last key in the file and had no value.
    return {
      path,
      warning: `host omp config at ${path} has 'modelRoles:' but no value follows; omp will boot without a model.`,
    };
  }
  return {
    path,
    warning: `host omp config at ${path} has no 'modelRoles' key; omp will boot without a model.`,
  };
}


/* ------------------------------------------------------------------ */
/* Session types                                                       */
/* ------------------------------------------------------------------ */

export interface ScenarioRef {
  readonly id: string;
  readonly title?: string;
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
  /** Extra env vars merged on top of the selected base environment (TERM is forced). */
  readonly env?: Readonly<Record<string, string>>;
  /** When false or unset, use the safe PTY environment allowlist; true opts into full inheritance. */
  readonly inheritEnv?: boolean;
  /** Host config path override; null disables host config discovery for this session. */
  readonly hostConfigPath?: string | null;
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
  readonly token: string;
  readonly url: string;
  /** Origin URL for visual browser clients; authentication is via an HttpOnly cookie. */
  readonly browserUrl: string;
  /** WebSocket path, e.g. `/ws`. The token goes in `?token=` (see `url`). */
  readonly wsPath: string;
  readonly scratchDir: string;
  readonly transcriptPath: string;
  readonly sessionJsonPath: string;
  readonly pty: { readonly pid: number | null; readonly cols: number; readonly rows: number; readonly mode: 'pty' | 'noPty' };
  /** Stop accepting connections, kill the PTY group, close everything. */
  readonly close: () => Promise<void>;
}

/** One line of the server-side transcript.jsonl (evidence backbone). */
export type TranscriptFrame =
  | { readonly ts: string; readonly t: 'o'; readonly d: string }
  | { readonly ts: string; readonly t: 'i'; readonly d: string }
  | { readonly ts: string; readonly t: 'exit'; readonly code: number; readonly signal?: number }
  | { readonly ts: string; readonly t: 'err'; readonly code: string; readonly message?: string };

/* ------------------------------------------------------------------ */
/* Session.json + concurrency guard                                    */
/* ------------------------------------------------------------------ */

export interface SessionInfo {
  readonly pid: number | null;
  readonly startedAt: string | null;
  readonly path: string;
}

/** Read `<scratch>/.work-state/ux-e2e/session.json`; null if absent/unparseable. */
export function readSessionInfo(scratchDir: string): SessionInfo | null {
  const p = join(scratchDir, '.work-state', 'ux-e2e', 'session.json');
  if (!existsSync(p)) return null;
  try {
    const j = JSON.parse(readFileSync(p, 'utf8')) as { pid?: unknown; started_at?: unknown };
    return {
      pid: typeof j.pid === 'number' ? j.pid : null,
      startedAt: typeof j.started_at === 'string' ? j.started_at : null,
      path: p,
    };
  } catch {
    return null;
  }
}

/** True if the pid refers to a live process on this host. */
export function pidIsLive(pid: number | null | undefined): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Concurrency guard: refuses to start a second session over a live one.
 * `force` allows the relaunch (the caller is responsible for cleanup).
 */
export function assertNoLiveSession(scratchDir: string, force: boolean): void {
  const info = readSessionInfo(scratchDir);
  if (info === null) return;
  if (pidIsLive(info.pid)) {
    if (force) return;
    throw new Error(
      `ux-e2e: live session found (pid ${info.pid}) at ${info.path}; stop it or pass --force to override`,
    );
  }
}

/* ------------------------------------------------------------------ */
/* HTTP security headers + CSP                                         */
/* ------------------------------------------------------------------ */

/**
 * Hardening headers applied to every HTTP response. Frame deny + referrer
 * policy are first-class defenses; CSP is layered on top in `cspHeader`.
 */
export function securityHeaders(host: string, port: number): Readonly<Record<string, string>> {
  return {
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
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

/** Outbound WS messages to the browser. */
export type ServerMsg =
  | { readonly t: 's'; readonly ok: true }
  | { readonly t: 'o'; readonly d: string }
  | { readonly t: 'exit'; readonly code: number; readonly signal?: number }
  | { readonly t: 'err'; readonly code: string; readonly message: string };

/** Inbound WS messages from the browser. */
type ClientMsg =
  | { readonly t: 'i'; readonly d: string }
  | { readonly t: 'r'; readonly cols: number; readonly rows: number };

function send(ws: WS, msg: ServerMsg): boolean {
  try {
    ws.send(JSON.stringify(msg));
    return true;
  } catch {
    return false;
  }
}

const SESSION_COOKIE = 'ux-e2e-token';

function readToken(req: IncomingMessage): string | null {
  try {
    const u = new URL(req.url ?? '/', 'http://placeholder.invalid/');
    const queryToken = u.searchParams.get('token');
    if (queryToken !== null && queryToken.length > 0) return queryToken;
  } catch {
    // Fall through to the cookie path.
  }
  const cookieHeader = req.headers.cookie;
  if (typeof cookieHeader !== 'string') return null;
  for (const part of cookieHeader.split(';')) {
    const separator = part.indexOf('=');
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    if (name !== SESSION_COOKIE) continue;
    const value = part.slice(separator + 1).trim();
    if (value.length === 0) return null;
    try {
      return decodeURIComponent(value);
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Origin / Host verification — ported from @pi-harness/web-terminal
 * `isLocalhostOrigin`. The server is bound to 127.0.0.1; the browser may
 * connect via `localhost` (or `[::1]`) instead — both refer to the same
 * loopback interface, so we accept them as long as the port matches.
 * Non-loopback hosts are NEVER aliased. The Origin header (when sent by
 * a browser) is checked in full; the Host header is the fallback for
 * curl / ws clients that omit Origin.
 */
const LOOPBACK_ALIASES = new Set(['127.0.0.1', 'localhost', '::1']);
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

export function originAllowed(req: IncomingMessage, expectedOrigin: string): boolean {
  let expectedHost = '';
  let expectedHostname = '';
  let expectedPort = '';
  let expectedProtocol = '';
  try {
    const u = new URL(expectedOrigin);
    expectedHost = u.host;
    expectedHostname = u.hostname;
    expectedProtocol = u.protocol;
    expectedPort = u.port;
  } catch {
    return false;
  }
  const origin = req.headers.origin;
  let candidateHost = '';
  let candidateHostname = '';
  let candidatePort = '';
  let candidateProto = '';
  if (typeof origin === 'string' && origin.length > 0) {
    try {
      const ou = new URL(origin);
      candidateHost = ou.host;
      candidateHostname = ou.hostname;
      candidateProto = ou.protocol;
      candidatePort = ou.port;
    } catch {
      return false;
    }
  } else {
    const hostHeader = req.headers.host;
    if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
    const parsed = parseHostPort(hostHeader);
    if (parsed === null) return false;
    candidateHost = hostHeader;
    candidateHostname = parsed.hostname;
    candidatePort = parsed.port;
  }
  if (candidateHost.length === 0) return false;
  if (candidateHost === expectedHost && (candidateProto.length === 0 || candidateProto === expectedProtocol)) return true;
  // 2) Loopback alias — localhost <-> 127.0.0.1 <-> ::1 — ports must match.
  if (
    LOOPBACK_ALIASES.has(candidateHostname) &&
    LOOPBACK_ALIASES.has(expectedHostname) &&
    candidatePort === expectedPort &&
    (candidateProto.length === 0 || candidateProto === expectedProtocol)
  ) {
    return true;
  }
  return false;
}

export type AttachResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no-token' | 'bad-token' | 'bad-origin' | 'closed' };

interface SessionControllerOptions {
  readonly pty: IPty | null;
  readonly spawnError: string | null;
  readonly idleMs: number;
  readonly transcriptPath: string;
}

class SessionController {
  readonly #opts: SessionControllerOptions;
  readonly #idler: IdleTimer;
  #attachedWs: WS | null = null;
  #closed = false;

  constructor(opts: SessionControllerOptions) {
    this.#opts = opts;
    this.#idler = new IdleTimer({
      idleMs: opts.idleMs,
      onIdle: () => {
        if (this.#closed) return;
        const message = `no inbound traffic for ${opts.idleMs}ms`;
        if (this.#attachedWs !== null) {
          send(this.#attachedWs, { t: 'err', code: 'idle-timeout', message });
        }
        this.#append({ ts: new Date().toISOString(), t: 'err', code: 'idle-timeout', message });
        void this.close();
      },
    });
    opts.pty?.onData(data => this.#handlePtyData(data));
    opts.pty?.onExit(({ exitCode, signal }) => this.#handlePtyExit(exitCode, signal));
  }

  get closed(): boolean {
    return this.#closed;
  }

  attach(ws: WS): void {
    if (this.#closed) {
      ws.close(1001, 'session closed');
      return;
    }
    this.#attachedWs = ws;
    this.#idler.bump();
    send(ws, { t: 's', ok: true });
    if (this.#opts.pty === null && this.#opts.spawnError !== null) {
      send(ws, { t: 'err', code: 'spawn-failed', message: this.#opts.spawnError });
      this.#append({ ts: new Date().toISOString(), t: 'err', code: 'spawn-failed', message: this.#opts.spawnError });
      ws.close(1000, 'spawn failed');
      void this.close();
    }
  }

  detach(ws: WS): void {
    if (this.#attachedWs === ws) this.#attachedWs = null;
  }

  handleMessage(ws: WS, raw: unknown, limiter: RateLimiter): void {
    if (this.#closed || this.#attachedWs !== ws) return;
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
    if (msg.t === 'i') {
      this.#append({ ts: new Date().toISOString(), t: 'i', d: msg.d });
      try {
        this.#opts.pty.write(msg.d);
      } catch {
        /* PTY may be dying — best-effort. */
      }
    } else if (msg.t === 'r' && msg.cols > 0 && msg.rows > 0) {
      try {
        this.#opts.pty.resize(Math.min(msg.cols, 1000), Math.min(msg.rows, 1000));
      } catch {
        /* resize can fail if the PTY is closing. */
      }
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.#idler.fireNow();
    const ws = this.#attachedWs;
    this.#attachedWs = null;
    if (ws !== null) {
      try {
        ws.close(1001, 'session closed');
      } catch {
        /* ignore. */
      }
    }
    if (this.#opts.pty !== null) await killProcessTree(this.#opts.pty.pid);
  }

  #handlePtyData(data: string): void {
    if (this.#closed) return;
    this.#append({ ts: new Date().toISOString(), t: 'o', d: data });
    if (this.#attachedWs !== null) send(this.#attachedWs, { t: 'o', d: data });
  }

  #handlePtyExit(exitCode: number, signal: number | undefined): void {
    if (this.#closed) return;
    const frame = {
      ts: new Date().toISOString(),
      t: 'exit',
      code: exitCode,
      ...(signal !== undefined ? { signal } : {}),
    } as const;
    this.#append(frame);
    if (this.#attachedWs !== null) {
      send(this.#attachedWs, { t: 'exit', code: exitCode, ...(signal !== undefined ? { signal } : {}) });
      this.#attachedWs.close(1000, 'pty exited');
    }
    this.#closed = true;
    this.#attachedWs = null;
    this.#idler.fireNow();
  }

  #append(frame: TranscriptFrame): void {
    try {
      appendSessionFile(this.#opts.transcriptPath, JSON.stringify(frame) + '\n');
    } catch {
      /* transcript is best-effort evidence — never fatal. */
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
  const token = readToken(req);
  if (token === null) return { ok: false, reason: 'no-token' };
  if (!safeEqual(token, expectedToken)) return { ok: false, reason: 'bad-token' };
  if (!originAllowed(req, opts.origin)) return { ok: false, reason: 'bad-origin' };
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

async function resolveOmpVersion(binary: string, env?: NodeJS.ProcessEnv): Promise<string> {
  try {
    const { promise, resolve: done, reject: fail } = deferred<string>();
    // stdin ignored: a fake test command must not block on --version.
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000, ...(env !== undefined ? { env } : {}) });
    let out = '';
    if (child.stdout !== null) {
      child.stdout.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
      });
    }
    child.on('error', err => fail(err));
    child.on('close', code => {
      if (code === 0) done(out);
      else fail(new Error(`--version exited with code ${String(code)}`));
    });
    const stdout = await promise;
    const first = stdout.trim().split('\n')[0];
    return first !== undefined && first.length > 0 ? first : 'unknown';
  } catch {
    return 'unknown';
  }
}

function stateDirOf(scratchDir: string): string {
  return join(scratchDir, '.work-state', 'ux-e2e');
}

/**
 * Start a test session: HTTP+WS server on 127.0.0.1 + one omp PTY.
 *
 * The caller is responsible for calling `close()` on shutdown — typically
 * from a SIGINT/SIGTERM handler or a `finally` block. The returned `url`
 * embeds a 256-bit session-scoped token valid only while the session lives.
 */
export async function startTestSession(opts: TestSessionOptions): Promise<TestSession> {
  if (typeof opts.cwd !== 'string' || opts.cwd.length === 0) {
    throw new Error('ux-e2e: startTestSession requires a cwd (scratch project directory)');
  }
  const host = '127.0.0.1';
  const publicHost = host;
  const scratchDir = resolve(opts.cwd);
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
  const launchBaseEnv = opts.inheritEnv === true ? process.env : safePtyEnv();
  const launchEnv = buildPtyEnv(launchBaseEnv, opts.env, { keepProxyEnv: opts.keepProxyEnv });

  const stateDir = stateDirOf(scratchDir);
  mkdirSync(stateDir, { recursive: true, mode: SESSION_DIR_MODE });
  const transcriptPath = join(stateDir, 'transcript.jsonl');
  const sessionJsonPath = join(stateDir, 'session.json');
  // Truncate the transcript — a fresh session starts with a clean evidence file.
  writeSessionFile(transcriptPath, '');

  const ompVersion = await resolveOmpVersion(ompBinary, launchEnv);

  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_WS_BYTES });
  // The 256-bit bearer token is session-scoped: localhost and origin checks
  // constrain its use, and reconnects remain possible until shutdown.

  const { promise: listening, resolve: bound, reject: bindFailed } = deferred<void>();
  httpServer.once('error', bindFailed);
  httpServer.listen(opts.port ?? 0, host, () => bound());
  await listening;
  const addr = httpServer.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('ux-e2e: failed to resolve bound port');
  }
  const boundPort = addr.port;
  const origin = `http://${publicHost}:${boundPort}`;
  const wsPath = '/ws';
  const url = `${origin}/?token=${encodeURIComponent(token)}`;
  /** Browser URL is intentionally bearer-free; the runner installs a cookie from a mode-600 file. */
  const browserUrl = `${origin}/`;
  // Resolve the host omp config FIRST so the warning is in session.json
  // (and stderr) regardless of noPty mode. omp merges `--config` overlays
  // in argv order — putting the host config before the ux-e2e overlay
  // means the overlay (later) wins for keys it explicitly sets, and the
  // host's `modelRoles` (and any other untouched keys) survive. Without
  // the host config, omp boots with "No model selected".
  const hostConfig = opts.hostConfigPath === null
    ? { path: null, warning: null }
    : checkHostOmpConfig(opts.hostConfigPath ?? undefined);
  if (hostConfig.warning !== null) {
    process.stderr.write(`ux-e2e: WARNING: ${hostConfig.warning}\n`);
  }
  // Operator-supplied overlay (opt-in): present-when-exists at
  // `<scratch>/.omp/ux-e2e-overlay.user.json`. When found, it is emitted
  // as the THIRD `--config` (after host config and the regenerated
  // ux-e2e overlay) so its keys win on conflict — letting a test run
  // pin `modelRoles` (or anything else) without touching the host
  // config or the regenerated standard overlay. Absence is the normal
  // case: the file is never auto-created, only consulted. Resolved early
  // so its presence is recorded in `session.json` regardless of noPty.
  const userConfigDefaultPath = join(scratchDir, '.omp', 'ux-e2e-overlay.user.json');
  const userConfigPath = existsSync(userConfigDefaultPath) ? userConfigDefaultPath : null;

  let ptyProc: IPty | null = null;
  let spawnError: string | null = null;
  if (opts.noPty !== true) {
    // node-pty is imported lazily: it is a native module whose prebuilt
    // binary may be missing on some platforms — noPty test sessions must
    // still work when the native module cannot load.
    const ptyMod = await import('node-pty');
    const args = buildOmpArgs({
      ompProfile,
      maxTimeSec,
      approvalMode,
      configPath: join(scratchDir, '.omp', 'ux-e2e-overlay.json'),
      sessionDir: join(scratchDir, '.omp', 'agent'),
      userConfigDefaultPath,
      ...(hostConfig.path !== null ? { hostConfigPath: hostConfig.path } : {}),
      ...(userConfigPath !== null ? { userConfigPath } : {}),
    });
    try {
      // omp is spawned directly (never wrapped in a shell), which is
      // inherently rc/profile-suppressed: no shell rc files can reorder
      // PATH or print noise into the terminal.
      ptyProc = ptyMod.spawn(ompBinary, args, { name: 'xterm-256color', cols, rows, cwd: scratchDir, env: launchEnv });
    } catch (err) {
      spawnError = err instanceof Error ? err.message : String(err);
    }
  }

  const sessionJson = {
    slug: deriveSlug(scratchDir),
    url,
    token,
    wsPath,
    pid: ptyProc?.pid ?? null,
    started_at: new Date().toISOString(),
    omp_version: ompVersion,
    profile: ompProfile,
    tty: { cols, rows, term: 'xterm-256color' },
    task_prompt: opts.taskPrompt !== null && opts.taskPrompt !== undefined ? sanitizeForJson(opts.taskPrompt) : null,
    scenario: opts.scenario ?? null,
    surface,
    host_config: {
      path: hostConfig.path,
      warning: hostConfig.warning,
    },
    user_config: {
      path: userConfigPath,
      default_path: userConfigDefaultPath,
    },
  };
  writeSessionFile(sessionJsonPath, JSON.stringify(sessionJson, null, 2) + '\n');
  // ---- HTTP: security headers + static page -------------------------
  const assets = resolveVendorAssets();
  httpServer.on('request', (req, res) => {
    const headers = securityHeaders(publicHost, boundPort);
    for (const [k, v] of Object.entries(headers)) res.setHeader(k, v);
    const path = pathnameOf(req);
    if (path === '/') {
      serveFile(res, assets.terminalHtml, 'text/html; charset=utf-8');
      return;
    }
    if (path === '/session-token.js') {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.end('not found');
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

  const controller = new SessionController({ pty: ptyProc, spawnError, idleMs, transcriptPath });

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

  const close = async (): Promise<void> => {
    wss.clients.forEach(c => {
      try {
        c.close(1001, 'server shutting down');
      } catch {
        /* ignore. */
      }
    });
    await controller.close();
    wss.close();
    const { promise: closed, resolve: done } = deferred<void>();
    httpServer.close(() => done());
    await closed;
  };

  return {
    host,
    publicHost,
    port: boundPort,
    token,
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
  };
}
