/**
 * UX E2E test server — localhost HTTP+WS bridge to a real omp PTY session.
 *
 * Hosts one HTTP+WS server on a loopback address with an ephemeral port,
 * serves a browser page (xterm) that talks to a single PTY running omp
 * with the omp-workflows plugin, and appends every PTY output frame to a
 * server-side `transcript.jsonl` — the evidence backbone for the report.
 *
 * Security posture (ported from @pi-harness/web-terminal, MIT):
 *   - binds to 127.0.0.1 — unreachable from other hosts;
 *   - one-shot single-use token in `?token=` (256-bit, URL-safe base64);
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
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { createRequire } from 'node:module';
import { basename, join, resolve } from 'node:path';
import type { Duplex } from 'node:stream';
import { fileURLToPath } from 'node:url';

import type { IPty } from 'node-pty';
import { WebSocketServer, type WebSocket as WS } from 'ws';

/** Max inbound WS frame size (defense-in-depth; the browser never needs more). */
export const MAX_INBOUND_WS_BYTES = 64 * 1024;

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

  const { promise: slept, resolve: finishSleep } = Promise.withResolvers<void>();
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
  readonly ompProfile: string;
  readonly maxTimeSec: number;
  readonly approvalMode: string;
  readonly configPath: string;
  readonly sessionDir: string;
}

/**
 * Build the omp argument vector. NEVER passes `-p`/`--print` and NEVER
 * `--no-pty` — the session must be a real interactive PTY.
 */
export function buildOmpArgs(cfg: OmpLaunchConfig): string[] {
  const maxMinutes = Math.max(1, Math.round(cfg.maxTimeSec / 60));
  return [
    '--profile', cfg.ompProfile,
    '--config', cfg.configPath,
    '--session-dir', cfg.sessionDir,
    '--hide-thinking',
    '--max-time', `${maxMinutes}m`,
    '--approval-mode', cfg.approvalMode,
  ];
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
  /** omp profile name. Default 'ux-e2e-test'. */
  readonly ompProfile?: string;
  /** Session time budget in seconds. Default 1800 (30 min). */
  readonly maxTimeSec?: number;
  /** omp approval mode. Default 'yolo'. */
  readonly approvalMode?: string;
  /** Task prompt recorded in session.json. */
  readonly taskPrompt?: string | null;
  /** Extra env vars merged on top of `process.env` (TERM is forced). */
  readonly env?: Readonly<Record<string, string>>;
  /** Pre-minted token override (tests). Default: freshly minted. */
  readonly token?: string;
  /**
   * Disable the PTY entirely — the server stays up and the WS protocol
   * works, but there is no process to drive. ONLY for server unit tests;
   * never for real e2e runs.
   */
  readonly noPty?: boolean;
}

/** Handle to a running test session. */
export interface TestSession {
  readonly host: '127.0.0.1';
  readonly publicHost: string;
  readonly port: number;
  readonly token: string;
  readonly url: string;
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

/** Hardening headers applied to every HTTP response. */
export function securityHeaders(host: string, port: number): Readonly<Record<string, string>> {
  return {
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': cspHeader(`http://${host}:${port}`),
  };
}

/** Strict CSP: no remote scripts, no frames, only self + the local WS. */
export function cspHeader(selfOrigin: string): string {
  let wsAllow = '';
  try {
    const u = new URL(selfOrigin);
    wsAllow = ` ws://${u.host}`;
  } catch {
    /* keep connect-src minimal on parse failure */
  }
  return `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'${wsAllow}`;
}

/* ------------------------------------------------------------------ */
/* Static assets (terminal page + vendored xterm)                      */
/* ------------------------------------------------------------------ */

interface VendorAssets {
  readonly terminalHtml: string;
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

function readToken(req: IncomingMessage): string | null {
  if (req.url === undefined) return null;
  try {
    const u = new URL(req.url, 'http://placeholder.invalid/');
    const t = u.searchParams.get('token');
    return t !== null && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

/**
 * Origin/Host verification. The Host header must match `<host>:<port>`
 * exactly (loopback-only server). The Origin header — sent by browsers —
 * is checked ONLY when present (curl / ws clients omit it and have no
 * ambient authority to abuse).
 */
function originAllowed(req: IncomingMessage, expectedOrigin: string): boolean {
  let expectedHost = '';
  try {
    expectedHost = new URL(expectedOrigin).host;
  } catch {
    return false;
  }
  const hostHeader = req.headers.host;
  if (typeof hostHeader !== 'string' || hostHeader.length === 0) return false;
  if (hostHeader !== expectedHost) return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin.length > 0) {
    return origin === expectedOrigin;
  }
  return true;
}

export type AttachResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: 'no-token' | 'bad-token' | 'bad-origin' };

interface AttachOptions {
  readonly origin: string;
  readonly pty: IPty | null;
  readonly spawnError: string | null;
  readonly cols: number;
  readonly rows: number;
  readonly idleMs: number;
  readonly rateLimit: Required<RateLimitOptions>;
  readonly transcriptPath: string;
}

/**
 * Wire one WS upgrade to the session's PTY. Authentication is
 * token + replay + origin checked BEFORE `handleUpgrade`, so a rejected
 * request never becomes a WebSocket.
 */
export function attachSession(
  req: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  wss: WebSocketServer,
  expectedToken: string,
  consumed: Set<string>,
  opts: AttachOptions,
): AttachResult {
  const token = readToken(req);
  if (token === null) return { ok: false, reason: 'no-token' };
  if (!safeEqual(token, expectedToken)) return { ok: false, reason: 'bad-token' };
  if (consumed.has(token)) return { ok: false, reason: 'bad-token' };
  if (!originAllowed(req, opts.origin)) return { ok: false, reason: 'bad-origin' };

  // Mark consumed BEFORE handleUpgrade: this token is single-use per
  // process and we cannot roll back a synchronous upgrade failure.
  consumed.add(token);

  const appendTranscript = (frame: TranscriptFrame): void => {
    try {
      appendFileSync(opts.transcriptPath, JSON.stringify(frame) + '\n');
    } catch {
      /* transcript is best-effort evidence — never fatal. */
    }
  };

  let closed = false;
  let attachedWs: WS | null = null;

  const limiter = new RateLimiter(opts.rateLimit);
  const idler = new IdleTimer({
    idleMs: opts.idleMs,
    onIdle: () => {
      if (closed) return;
      const msg = `no inbound traffic for ${opts.idleMs}ms`;
      if (attachedWs !== null) {
        send(attachedWs, { t: 'err', code: 'idle-timeout', message: msg });
      }
      appendTranscript({ ts: new Date().toISOString(), t: 'err', code: 'idle-timeout', message: msg });
      void detach();
    },
  });

  const detach = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    idler.fireNow();
    if (attachedWs !== null) {
      try {
        attachedWs.close(1001, 'session closed');
      } catch {
        /* ignore. */
      }
    }
    if (opts.pty !== null) {
      await killProcessTree(opts.pty.pid);
    }
  };

  wss.handleUpgrade(req, socket, head, ws => {
    attachedWs = ws;
    idler.bump();

    // Authenticated — ack first.
    send(ws, { t: 's', ok: true });

    if (opts.pty === null) {
      if (opts.spawnError !== null) {
        send(ws, { t: 'err', code: 'spawn-failed', message: opts.spawnError });
        appendTranscript({ ts: new Date().toISOString(), t: 'err', code: 'spawn-failed', message: opts.spawnError });
        try {
          ws.close(1000, 'spawn failed');
        } catch {
          /* ignore. */
        }
        return;
      }
      // noPty test mode — keep the socket open; input is rejected below.
    } else {
      const ptyProc = opts.pty;
      ptyProc.onData(data => {
        if (closed) return;
        const frame = { ts: new Date().toISOString(), t: 'o', d: data } as const;
        appendTranscript(frame);
        send(ws, { t: 'o', d: data });
      });
      ptyProc.onExit(({ exitCode, signal }) => {
        if (closed) return;
        const msg: ServerMsg = {
          t: 'exit',
          code: exitCode,
          ...(signal !== undefined ? { signal } : {}),
        };
        appendTranscript({ ts: new Date().toISOString(), t: 'exit', code: exitCode, ...(signal !== undefined ? { signal } : {}) });
        send(ws, msg);
        try {
          ws.close(1000, 'pty exited');
        } catch {
          /* ignore. */
        }
        void detach();
      });
    }

    ws.on('message', raw => {
      idler.bump();
      if (!limiter.record()) {
        // Hard cap reached — kick the client so the PTY stays responsive.
        send(ws, { t: 'err', code: 'rate-limited', message: 'too many messages' });
        appendTranscript({ ts: new Date().toISOString(), t: 'err', code: 'rate-limited' });
        try {
          ws.close(1008, 'rate limited');
        } catch {
          /* ignore. */
        }
        return;
      }
      let msg: ClientMsg;
      try {
        const text = typeof raw === 'string' ? raw : raw.toString('utf8');
        if (text.length > MAX_INBOUND_WS_BYTES) return;
        msg = JSON.parse(text) as ClientMsg;
      } catch {
        return;
      }
      if (msg.t === 'i') {
        if (opts.pty === null) {
          const m = 'this session has no PTY (noPty mode)';
          send(ws, { t: 'err', code: 'no-pty', message: m });
          appendTranscript({ ts: new Date().toISOString(), t: 'err', code: 'no-pty', message: m });
          try {
            ws.close(1000, 'no pty');
          } catch {
            /* ignore. */
          }
          return;
        }
        appendTranscript({ ts: new Date().toISOString(), t: 'i', d: msg.d });
        try {
          opts.pty.write(msg.d);
        } catch {
          /* PTY may be dying — best-effort. */
        }
      } else if (msg.t === 'r') {
        if (opts.pty === null) return;
        if (msg.cols > 0 && msg.rows > 0) {
          try {
            opts.pty.resize(Math.min(msg.cols, 1000), Math.min(msg.rows, 1000));
          } catch {
            /* resize can fail if the PTY is closing. */
          }
        }
      }
    });

    ws.on('close', () => {
      void detach();
    });
    ws.on('error', () => {
      void detach();
    });
  });

  return { ok: true as const };
}

/* ------------------------------------------------------------------ */
/* Server bootstrap                                                    */
/* ------------------------------------------------------------------ */

function deriveSlug(scratchDir: string): string {
  const base = basename(scratchDir);
  const PREFIX = 'omp-ux-e2e-';
  return base.startsWith(PREFIX) ? base.slice(PREFIX.length) : base;
}

async function resolveOmpVersion(binary: string): Promise<string> {
  try {
    const { promise, resolve: done, reject: fail } = Promise.withResolvers<string>();
    // stdin ignored: a fake test command must not block on --version.
    const child = spawn(binary, ['--version'], { stdio: ['ignore', 'pipe', 'pipe'], timeout: 5000 });
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
 * embeds the single-use token; it is the only thing an operator needs.
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
  const ompProfile = opts.ompProfile ?? 'ux-e2e-test';
  const maxTimeSec = opts.maxTimeSec ?? 1800;
  const approvalMode = opts.approvalMode ?? 'yolo';
  const token = opts.token ?? mintToken();

  const stateDir = stateDirOf(scratchDir);
  mkdirSync(stateDir, { recursive: true });
  const transcriptPath = join(stateDir, 'transcript.jsonl');
  const sessionJsonPath = join(stateDir, 'session.json');
  // Truncate the transcript — a fresh session starts with a clean evidence file.
  writeFileSync(transcriptPath, '');

  const ompVersion = await resolveOmpVersion(ompBinary);

  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_INBOUND_WS_BYTES });
  const consumed = new Set<string>();

  const { promise: listening, resolve: bound, reject: bindFailed } = Promise.withResolvers<void>();
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
  const url = `http://${publicHost}:${boundPort}/?token=${encodeURIComponent(token)}`;

  // ---- PTY: spawn omp (or a fake command in unit tests) -------------
  let ptyProc: IPty | null = null;
  let spawnError: string | null = null;
  if (opts.noPty !== true) {
    // node-pty is imported lazily: it is a native module whose prebuilt
  // binary may be missing on some platforms — noPty test sessions must
  // still work when the native module cannot load.
  const ptyMod = await import('node-pty');
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      TERM: 'xterm-256color',
      ...opts.env,
    };
    const args = buildOmpArgs({
      ompProfile,
      maxTimeSec,
      approvalMode,
      configPath: join(scratchDir, '.omp', 'ux-e2e-overlay.json'),
      sessionDir: join(scratchDir, '.omp', 'agent'),
    });
    try {
      // omp is spawned directly (never wrapped in a shell), which is
      // inherently rc/profile-suppressed: no shell rc files can reorder
      // PATH or print noise into the terminal.
      ptyProc = ptyMod.spawn(ompBinary, args, { name: 'xterm-256color', cols, rows, cwd: scratchDir, env });
    } catch (err) {
      spawnError = err instanceof Error ? err.message : String(err);
    }
  }

  // ---- session.json (evidence pointer for report/stop/transcript) ----
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
    task_prompt: opts.taskPrompt ?? null,
    scenario: opts.scenario ?? null,
    surface,
  };
  writeFileSync(sessionJsonPath, JSON.stringify(sessionJson, null, 2) + '\n');

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

  // ---- WS: authenticated upgrade -------------------------------------
  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const result = attachSession(req, socket, head, wss, token, consumed, {
      origin,
      pty: ptyProc,
      spawnError,
      cols,
      rows,
      idleMs,
      rateLimit,
      transcriptPath,
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
    wss.close();
    if (ptyProc !== null) {
      await killProcessTree(ptyProc.pid);
    }
    const { promise: closed, resolve: done } = Promise.withResolvers<void>();
    httpServer.close(() => done());
    await closed;
  };

  return {
    host,
    publicHost,
    port: boundPort,
    token,
    url,
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
