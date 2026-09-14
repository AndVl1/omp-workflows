/**
 * Terminal drivers + transcript analysis.
 *
 * `TerminalDriver` is the single seam between the framework and the
 * terminal surface. Two real implementations exist:
 *   - `WsDriver` — pure WS text mode: `readScreen()` tails the
 *     server-side transcript.jsonl, no browser needed;
 *   - `PlaywrightDriver` — real chromium via the lazy `playwright`
 *     dependency (clear error when the package is not installed).
 *
 * `TranscriptLog` and `AskStateTracker` implement the [ask_user]
 * detection heuristics on top of the append-only transcript.
 */

import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, join, resolve } from 'node:path';

import type { Browser, Page } from 'playwright';
import { WebSocket } from 'ws';

import type { TranscriptFrame } from './server.js';

import {
  appendPinnedFile,
  closePinnedDirectory,
  closePinnedFile,
  openPinnedFile,
  pinDirectory,
  pinnedDirectoryIsStable,
  readPinnedFile,
  readPinnedFileFull,
  processStartIdentity,
  withPinnedExclusiveLock,
  type PinnedDirectory,
} from './fs-safety.js';
import { deferred } from './util.js';
/* ------------------------------------------------------------------ */
/* Small async helpers                                                 */
/* ------------------------------------------------------------------ */

export class WaitTimeoutError extends Error {}

export interface WaitForOptions {
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly label?: string;
}

/** Poll `cond` until truthy; throw `WaitTimeoutError` on timeout. */
export async function waitFor(
  cond: () => boolean | Promise<boolean>,
  opts: WaitForOptions = {},
): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  const intervalMs = opts.intervalMs ?? 25;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await cond()) return;
    if (Date.now() >= deadline) {
      throw new WaitTimeoutError(
        `waitFor timed out after ${timeoutMs}ms${opts.label !== undefined ? ` (${opts.label})` : ''}`,
      );
    }
    const { promise: ticked, resolve: tick } = deferred<void>();
    setTimeout(tick, intervalMs);
    await ticked;
  }
}

/** Remove terminal controls in one pass before text reaches an operator terminal. */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(
    /(?:\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|(?:P|X|\^|_)[^\u001b]*(?:\u001b\\)|\[[0-?]*[ -/]*[@-~]|[ -/]*[@-~])|\u009d[^\u0007]*(?:\u0007|\u001b\\)|[\u0090\u0098\u009e\u009f][^\u001b]*(?:\u001b\\)|\u009b[0-?]*[ -/]*[@-~]|[\u0080-\u009c]|[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f\r])/gu,
    '',
  ).replace(/[\u001b\u0080-\u009f]/gu, '');
}
/* ------------------------------------------------------------------ */
/* TerminalDriver interface                                            */
/* ------------------------------------------------------------------ */

/**
 * Stable startup evidence emitted by the real omp TUI. Input must not be
 * sent until the welcome screen and prompt footer have rendered: node-pty can
 * otherwise accept bytes while omp is still initializing and discard them.
 */
export function isOmpTuiReady(text: string): boolean {
  const screen = stripAnsi(text);
  return /Welcome back!/u.test(screen)
    && /\/ for commands/u.test(screen)
    && /(?:╭──\s*π\s*>|π\s+>)/u.test(screen);
}

/** Wait for a real omp TUI to finish rendering before sending input. */
export async function waitForOmpTuiReady(
  driver: Pick<TerminalDriver, 'readScreen'>,
  opts: WaitForOptions = {},
): Promise<void> {
  await waitFor(
    async () => isOmpTuiReady(await driver.readScreen()),
    {
      timeoutMs: opts.timeoutMs ?? 60_000,
      intervalMs: opts.intervalMs ?? 100,
      label: opts.label ?? 'OMP TUI ready',
    },
  );
}

export type TerminalKey = "Enter" | "Tab" | "ArrowUp" | "ArrowDown" | "ArrowLeft" | "ArrowRight" | "Escape";

const TERMINAL_KEY_BYTES: Readonly<Record<TerminalKey, string>> = {
  Enter: "\r",
  Tab: "\t",
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowLeft: "\x1b[D",
  ArrowRight: "\x1b[C",
  Escape: "\x1b",
};

export interface TerminalDriver {
  /** Connect to the session surface (opens the WS / launches the browser). */
  open(url: string): Promise<void>;
  /** Return the current terminal screen as text. */
  readScreen(): Promise<string>;
  /** Save a screenshot; returns the written path. Throws in text mode. */
  screenshot(path: string): Promise<string>;
  /** Send raw text to the terminal (no trailing newline added). */
  type(text: string): Promise<void>;
  /**
   * Start an authenticated, ordered input sequence. Native Ask answers use
   * this to make every keypress recoverable without replaying a prefix.
   */
  beginInputSequence?(stepCount: number): void;
  /** Finish the current ordered input sequence after its final receipt. */
  endInputSequence?(): void;
  /**
   * Send a real Enter (CR, 0x0D) to the PTY. Text-mode drivers send
   * '\r' directly; web drivers dispatch a real Enter key via the
   * browser so xterm forwards '\r' exactly as a human keyboard
   * would. '\n' is NOT a substitute — it inserts a line break into
   * the editor and does not submit.
   */
  pressEnter(isFinalSubmit?: boolean): Promise<void>;
  /** Send one navigation key to an interactive terminal prompt. */
  pressKey?(key: TerminalKey): Promise<void>;
  /** Close the connection / browser. */
  close(): Promise<void>;
}

/**
 * Validate the page URL before either driver performs network I/O.
 *
 * The session server is intentionally loopback-only.  Keep this check in one
 * place so the WS and browser surfaces cannot drift into different URL
 * policies.  The port is inspected from the original authority because WHATWG
 * URL normalizes explicit default ports (`:80`/`:443`) to an empty `port`.
 */
export function validateSessionUrl(pageUrl: string): URL {
  let url: URL;
  try {
    url = new URL(pageUrl);
  } catch {
    throw new Error('ux-e2e: invalid session URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('ux-e2e: session URL must use http or https');
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new Error('ux-e2e: session URL must not contain userinfo');
  }

  const hostname = url.hostname.toLowerCase();
  const loopbackHost = hostname === 'localhost'
    || hostname === '127.0.0.1'
    || hostname === '[::1]';
  if (!loopbackHost) {
    throw new Error('ux-e2e: session URL host must be localhost, 127.0.0.1, or ::1');
  }

  const authorityMatch = pageUrl.match(/^[a-z][a-z\d+.-]*:\/\/([^/?#]*)/iu);
  const authority = authorityMatch?.[1] ?? '';
  let rawPort: string;
  if (authority.startsWith('[')) {
    const closingBracket = authority.indexOf(']');
    rawPort = closingBracket >= 0 && authority[closingBracket + 1] === ':'
      ? authority.slice(closingBracket + 2)
      : '';
  } else {
    const colon = authority.lastIndexOf(':');
    rawPort = colon >= 0 ? authority.slice(colon + 1) : '';
  }
  if (!/^\d+$/u.test(rawPort)) {
    throw new Error('ux-e2e: session URL must contain an explicit valid port');
  }
  const port = Number(rawPort);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error('ux-e2e: session URL must contain an explicit valid port');
  }
  return url;
}
export interface WsDriverOptions {
  /** WS page URL from session.json (`http://host:port/?token=...`). */
  readonly url: string;
  /** Path of the server-side transcript.jsonl used by readScreen(). */
  readonly transcriptPath: string;
  /** Optional feature selector carried on the WS URL. */
  readonly feature_id?: string;
  /** Optional run selector carried on the WS URL. */
  readonly run_key?: string;
  /** Focused-test failpoint invoked after each acknowledged sequenced step. */
  readonly inputStepHook?: (step: InputStep) => void;
  /** Bounded PTY receipt window for descriptor-heavy focused sessions. */
  readonly inputReceiptTimeoutMs?: number;
}

export interface InputStep {
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly isFinalSubmit: boolean;
}

interface InputSequence {
  stepIndex: number;
  readonly stepCount: number;
  finalSubmitSeen: boolean;
}

interface InputReceipt {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
  readonly timer: NodeJS.Timeout;
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly isFinalSubmit: boolean;
}

/**
 * Pure-WS terminal driver. `readScreen()` tails the server-side
 * transcript (the same evidence file the report uses), so the text
 * surface never needs a browser.
 */
export class WsDriver implements TerminalDriver {
  readonly #wsUrl: string;
  readonly #transcriptPath: string;
  readonly #transcriptName: string;
  readonly #transcriptRoot: PinnedDirectory | null;
  #ws: WebSocket | null = null;
  #nextSequence = 1;
  #reservationId: string | null = null;
  #inputSequence: InputSequence | null = null;
  readonly #receipts = new Map<number, InputReceipt>();
  #socketFailure: Error | null = null;
  readonly #inputStepHook: ((step: InputStep) => void) | null;
  readonly #inputReceiptTimeoutMs: number;
  constructor(opts: WsDriverOptions) {
    this.#wsUrl = wsUrlFromPageUrl(opts.url, {
      feature_id: opts.feature_id,
      run_key: opts.run_key,
    });
    this.#transcriptPath = resolve(opts.transcriptPath);
    this.#transcriptName = basename(this.#transcriptPath);
    this.#transcriptRoot = pinDirectory(dirname(this.#transcriptPath));
    this.#inputStepHook = opts.inputStepHook ?? null;
    const inputReceiptTimeoutMs = opts.inputReceiptTimeoutMs ?? 5_000;
    if (!Number.isSafeInteger(inputReceiptTimeoutMs) || inputReceiptTimeoutMs <= 0 || inputReceiptTimeoutMs > 90_000) {
      throw new Error('ux-e2e: inputReceiptTimeoutMs must be a positive integer <= 90000');
    }
    this.#inputReceiptTimeoutMs = inputReceiptTimeoutMs;
  }

  #rejectReceipts(error: Error): void {
    for (const [sequence, receipt] of this.#receipts) {
      this.#receipts.delete(sequence);
      clearTimeout(receipt.timer);
      receipt.reject(error);
    }
  }

  #fenceSocket(ws: WebSocket, error: Error): void {
    if (this.#ws !== ws && this.#socketFailure !== null) return;
    this.#socketFailure ??= error;
    if (this.#ws === ws) this.#ws = null;
    this.#rejectReceipts(this.#socketFailure);
  }

  #handleReceipt(raw: unknown): void {
    try {
      const text = typeof raw === 'string' ? raw : Buffer.isBuffer(raw) ? raw.toString('utf8') : String(raw);
      const msg = JSON.parse(text) as {
        t?: string;
        sequence?: unknown;
        reservation_id?: unknown;
        step_index?: unknown;
        step_count?: unknown;
        is_final_submit?: unknown;
      };
      const sequence = typeof msg.sequence === 'number' && Number.isSafeInteger(msg.sequence) ? msg.sequence : null;
      if (msg.t !== 'ack' || sequence === null) return;
      const receipt = this.#receipts.get(sequence);
      if (receipt === undefined) return;
      if (this.#reservationId !== null
        && (typeof msg.reservation_id !== 'string' || msg.reservation_id !== this.#reservationId)) return;
      if (msg.step_index !== receipt.stepIndex
        || msg.step_count !== receipt.stepCount
        || msg.is_final_submit !== receipt.isFinalSubmit) return;
      this.#receipts.delete(sequence);
      clearTimeout(receipt.timer);
      receipt.resolve();
    } catch {
      /* Ignore non-receipt server frames. */
    }
  }
  async open(): Promise<void> {
    if (this.#ws !== null) return;
    const ws = new WebSocket(this.#wsUrl);
    const { promise: opened, resolve: openSucceeded, reject: openFailed } = deferred<void>();
    ws.once('open', () => openSucceeded());
    ws.once('error', err => openFailed(err));

    // Auth ack: the server sends {t:'s', ok:true} right after upgrade.
    const { promise: acked, resolve: ackReceived, reject: ackFailed } = deferred<void>();
    ws.once('message', raw => {
      try {
        const msg = JSON.parse(raw.toString('utf8')) as { t?: string; ok?: boolean };
        if (msg.t === 's' && msg.ok === true) ackReceived();
        else ackFailed(new Error(`ux-e2e: unexpected first frame ${stripAnsi(raw.toString('utf8')).slice(0, 1024)}`));
      } catch (err) {
        ackFailed(err instanceof Error ? err : new Error(String(err)));
      }
    });
    let timer: NodeJS.Timeout | undefined;
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new WaitTimeoutError('ux-e2e: ws handshake timeout')), 5000);
      });
      await Promise.race([opened, deadline]);
      await Promise.race([acked, deadline]);
      this.#ws = ws;
      this.#socketFailure = null;
      ws.on('message', raw => this.#handleReceipt(raw));
      // Once the handshake is complete, an error/close is an ownership
      // boundary: fence this socket and reject every receipt immediately.
      // Keeping an error listener installed also prevents Node's unhandled
      // 'error' event when the server disappears during a write.
      ws.on('error', error => this.#fenceSocket(ws, error instanceof Error ? error : new Error(String(error))));
      ws.on('close', (code, reason) => this.#fenceSocket(ws, new Error(`ux-e2e: ws closed before PTY input receipt (${String(code)}${reason.length > 0 ? `: ${reason.toString('utf8').slice(0, 128)}` : ''})`)));
    } catch (err) {
      // The one-shot handshake listener has already consumed the first error;
      // retain a no-op listener while terminate() drains any follow-up error.
      ws.on('error', () => undefined);
      try { ws.terminate(); } catch { /* ignore. */ }
      throw err;
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async readScreen(): Promise<string> {
    const root = this.#transcriptRoot;
    if (root === null || !pinnedDirectoryIsStable(root)) return '';
    const bytes = readPinnedFile(root, this.#transcriptName, 8 * 1024 * 1024, 1024 * 1024);
    if (bytes === null) return '';
    const text = bytes.toString('utf8');
    const chunks: string[] = [];
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const f = JSON.parse(line) as TranscriptFrame;
        if (f.t === 'o' && typeof f.d === 'string') chunks.push(f.d);
      } catch {
        /* skip partial lines */
      }
    }
    return stripAnsi(chunks.join(''));
  }

  async screenshot(_path: string): Promise<string> {
    throw new Error('ux-e2e: no browser surface in text mode — use --surface web with playwright installed');
  }

  beginInputSequence(stepCount: number): void {
    if (!Number.isSafeInteger(stepCount) || stepCount < 1 || stepCount > 10_000) {
      throw new Error('ux-e2e: invalid input sequence length');
    }
    if (this.#inputSequence !== null) throw new Error('ux-e2e: input sequence already active');
    this.#inputSequence = { stepIndex: 0, stepCount, finalSubmitSeen: false };
  }

  endInputSequence(): void {
    const sequence = this.#inputSequence;
    if (sequence === null) return;
    if (sequence.stepIndex !== sequence.stepCount || !sequence.finalSubmitSeen) {
      throw new Error('ux-e2e: input sequence ended before final submit receipt');
    }
    this.#inputSequence = null;
  }

  async #sendInput(text: string, isFinalSubmit: boolean): Promise<void> {
    if (this.#ws === null || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error('ux-e2e: ws not open — call open() first');
    }
    const active = this.#inputSequence;
    const stepIndex = active === null ? 1 : active.stepIndex + 1;
    const stepCount = active === null ? 1 : active.stepCount;
    if (stepIndex > stepCount) throw new Error('ux-e2e: input sequence has too many frames');
    if (isFinalSubmit && stepIndex !== stepCount) {
      throw new Error('ux-e2e: final submit must be the last input frame');
    }
    if (active !== null) {
      active.stepIndex = stepIndex;
      if (isFinalSubmit) active.finalSubmitSeen = true;
    }
    const sequence = this.#nextSequence;
    this.#nextSequence = this.#nextSequence >= 2_147_483_647 ? 1 : this.#nextSequence + 1;
    const payload = {
      t: 'i' as const,
      d: text,
      sequence,
      ...(this.#reservationId !== null ? { reservation_id: this.#reservationId } : {}),
      step_index: stepIndex,
      step_count: stepCount,
      is_final_submit: isFinalSubmit,
    };
    const { promise, resolve: receiptReceived, reject: receiptFailed } = deferred<void>();
    const timer = setTimeout(() => {
      this.#receipts.delete(sequence);
      receiptFailed(new WaitTimeoutError(`ux-e2e: PTY input receipt timeout (sequence ${String(sequence)})`));
    }, this.#inputReceiptTimeoutMs);
    this.#receipts.set(sequence, {
      resolve: receiptReceived,
      reject: receiptFailed,
      timer,
      stepIndex,
      stepCount,
      isFinalSubmit,
    });
    try {
      this.#ws.send(JSON.stringify(payload));
      await promise;
      if (active !== null) {
        this.#inputStepHook?.({ stepIndex, stepCount, isFinalSubmit });
      }
    } catch (error) {
      this.#receipts.delete(sequence);
      clearTimeout(timer);
      throw error;
    }
  }

  async type(text: string): Promise<void> {
    await this.#sendInput(text, false);
  }

  /** Bind subsequent input receipts to one Ask reservation. */
  setReservation(reservationId: string | null): void {
    if (reservationId !== null && (reservationId.length === 0 || reservationId.length > 128)) {
      throw new Error('ux-e2e: invalid Ask reservation id');
    }
    this.#reservationId = reservationId;
  }
  /**
   * Send Enter to the PTY as a real Enter keypress would: '\r' (CR,
   * 0x0D). '\n' is NOT equivalent — it inserts a line break into the
   * editor buffer and does not submit. (The legacy `submit()` helper
   * uses '\n' for backward compatibility with old text surfaces that
   * normalised LF → CR; prefer `pressEnter()` on modern PTYs.)
   */
  async pressEnter(isFinalSubmit = true): Promise<void> {
    await this.#sendInput("\r", isFinalSubmit);
  }

  async pressKey(key: TerminalKey): Promise<void> {
    await this.#sendInput(TERMINAL_KEY_BYTES[key], false);
  }

  /** Submit text to omp as a single frame. Uses LF for backward compat. */
  async submit(text: string): Promise<void> {
    await this.#sendInput(text + '\n', true);
  }
  /** Submit one reservation-bound payload and await the server's PTY-write receipt. */
  async submitReserved(text: string, reservationId: string): Promise<void> {
    this.setReservation(reservationId);
    try {
      await this.#sendInput(text + '\n', true);
    } finally {
      this.setReservation(null);
    }
  }

  async close(): Promise<void> {
    const ws = this.#ws;
    this.#ws = null;
    this.#socketFailure = new Error('ux-e2e: ws closed before PTY input receipt');
    this.#rejectReceipts(this.#socketFailure);
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        /* ignore. */
      }
    }
    if (this.#transcriptRoot !== null) closePinnedDirectory(this.#transcriptRoot);
  }
}

/** Build the `ws://host:port/ws?token=...` URL from the page URL. */
export function wsUrlFromPageUrl(
  pageUrl: string,
  selectors: { readonly feature_id?: string; readonly run_key?: string } = {},
): string {
  const u = validateSessionUrl(pageUrl);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = u.searchParams.get('token') ?? '';
  const featureId = selectors.feature_id ?? u.searchParams.get('feature_id') ?? undefined;
  const runKey = selectors.run_key ?? u.searchParams.get('run_key') ?? undefined;
  if ((featureId === undefined) !== (runKey === undefined)) {
    throw new Error('ux-e2e: feature_id and run_key selectors must be provided together');
  }
  const query = [`token=${encodeURIComponent(token)}`];
  if (featureId !== undefined && runKey !== undefined) {
    query.push(`feature_id=${encodeURIComponent(featureId)}`, `run_key=${encodeURIComponent(runKey)}`);
  }
  return `${proto}//${u.host}/ws?${query.join('&')}`;
}

interface PageTerminal {
  readonly buffer: {
    readonly active: {
      readonly length: number;
      getLine(index: number): { translateToString(): string } | undefined;
    };
  };
  focus(): void;
}

interface PageGlobal {
  __uxTerm?: PageTerminal;
}

interface PlaywrightModule {
  chromium: {
    launch(opts: { headless: boolean }): Promise<Browser>;
  };
}

/**
 * Create the playwright-backed driver. `playwright` is a lazy optional
 * devDependency: the runtime module may not be installed at all, so the
 * static import is impossible here — a dynamic import is the only way to
 * produce the clear "install playwright" error instead of a module crash.
 */
export async function createPlaywrightDriver(opts: { readonly headless?: boolean } = {}): Promise<TerminalDriver> {
  let pw: PlaywrightModule;
  try {
    pw = (await import('playwright')) as PlaywrightModule;
  } catch {
    throw new Error(
      'ux-e2e: playwright is not installed — add it with `npm i -D playwright` to use the web surface',
    );
  }
  return new PlaywrightDriver(pw, opts.headless ?? true);
}

class PlaywrightDriver implements TerminalDriver {
  readonly #pw: PlaywrightModule;
  readonly #headless: boolean;
  #browser: Browser | null = null;
  #page: Page | null = null;

  constructor(pw: PlaywrightModule, headless: boolean) {
    this.#pw = pw;
    this.#headless = headless;
  }

  async open(url: string): Promise<void> {
    validateSessionUrl(url);
    const browser = await this.#pw.chromium.launch({ headless: this.#headless });
    try {
      const page = await browser.newPage();
      await page.goto(url, { waitUntil: 'load' });
      await page.waitForFunction(
        () => (globalThis as unknown as PageGlobal).__uxTerm !== undefined,
        { timeout: 10_000 },
      );
      this.#browser = browser;
      this.#page = page;
    } catch (error) {
      try {
        await browser.close();
      } catch {
        /* ignore cleanup failure; preserve the open error. */
      }
      throw error;
    }
  }

  async readScreen(): Promise<string> {
    if (this.#page === null) throw new Error('ux-e2e: playwright page not open — call open() first');
    const text = await this.#page.evaluate(() => {
      const term = (globalThis as unknown as PageGlobal).__uxTerm;
      if (term === undefined) return '';
      const rows: string[] = [];
      const active = term.buffer.active;
      for (let i = 0; i < active.length; i += 1) {
        const line = active.getLine(i);
        if (line !== undefined) rows.push(line.translateToString());
      }
      return rows.join('\n');
    });
    return stripAnsi(text);
  }

  async screenshot(path: string): Promise<string> {
    if (this.#page === null) throw new Error('ux-e2e: playwright page not open — call open() first');
    await this.#page.screenshot({ path });
    return path;
  }

  async type(text: string): Promise<void> {
    if (this.#page === null) throw new Error('ux-e2e: playwright page not open — call open() first');
    await this.#page.evaluate(() => {
      (globalThis as unknown as PageGlobal).__uxTerm?.focus();
    });
    await this.#page.keyboard.insertText(text);
  }

  /**
   * Send a real Enter keypress through the browser. Routes through
   * the OS-level keyboard path (CDP `Input.dispatchKeyEvent`) so
   * xterm forwards '\r' to the PTY exactly as a human keyboard
   * would. '\n' is NOT a substitute — see `pressEnter()` on
   * `WsDriver` for the full Enter-semantics rationale.
   */
  async pressEnter(_isFinalSubmit = true): Promise<void> {
    if (this.#page === null) throw new Error('ux-e2e: playwright page not open — call open() first');
    await this.#page.evaluate(() => {
      (globalThis as unknown as PageGlobal).__uxTerm?.focus();
    });
    await this.#page.keyboard.press('Enter');
  }

  async pressKey(key: TerminalKey): Promise<void> {
    if (this.#page === null) throw new Error('ux-e2e: playwright page not open — call open() first');
    await this.#page.evaluate(() => {
      (globalThis as unknown as PageGlobal).__uxTerm?.focus();
    });
    await this.#page.keyboard.press(key);
  }

  async close(): Promise<void> {
    const browser = this.#browser;
    this.#browser = null;
    this.#page = null;
    if (browser !== null) {
      try {
        await browser.close();
      } catch {
        /* ignore. */
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* TranscriptLog — append-only scan with a cursor                      */
/* ------------------------------------------------------------------ */

export interface AskOption {
  readonly label: string;
  readonly description?: string;
}

export interface AskQuestion {
  readonly id: string;
  readonly prompt: string;
  readonly options: readonly AskOption[];
}

export interface AskBlock {
  /** 1-based display ordinal of the ask in the currently retained transcript. */
  readonly index: number;
  /** Human-readable title or compatibility context for this ask. */
  readonly title: string;
  /** Legacy numbered options, retained for existing callers. */
  readonly options: string[];
  /** Surface that produced the interaction. */
  readonly surface: "legacy" | "native";
  /** Structured questions; native cards can contain more than one. */
  readonly questions: readonly AskQuestion[];
  /** Absolute serial of the first retained frame containing the block. */
  readonly frameStart: number;
  /** Absolute serial immediately after the last frame belonging to the block. */
  readonly frameEnd: number;
}

/** A single-select checkpoint rendered by the host UI `ui.select` surface.
 *
 * This is intentionally separate from `AskBlock`: selected checkpoint asks are
 * answered with terminal navigation events, not the persisted ask-state log.
 */
export interface SelectedAskBlock {
  /** 1-based index of the selected-ask card in the transcript. */
  readonly index: number;
  /** Human-readable checkpoint context. */
  readonly title: string;
  /** Labels rendered by the selector, in navigation order. */
  readonly options: string[];
  /** Zero-based option currently marked by the selector cursor. */
  readonly selectedIndex: number;
  /** Surface that produced the interaction. */
  readonly surface: "selector";
  /** Absolute serial of the first retained frame containing the block. */
  readonly frameStart: number;
  /** Absolute serial immediately after the last frame belonging to the block. */
  readonly frameEnd: number;
}

const OPTION_LINE_RE = /^\s*(?:\d+[.)\]]\s*|\*\s*|-\s*|\[[ xX]\]\s*)/u;

function askBlockPayloadDigest(block: Pick<AskBlock, 'title' | 'options' | 'surface' | 'questions'>): string {
  return createHash('sha256').update(JSON.stringify({
    title: block.title,
    options: block.options,
    surface: block.surface,
    questions: block.questions,
  }), 'utf8').digest('hex');
}

function frameAtOffset(
  outputs: ReadonlyArray<{ readonly frame: number; readonly text: string }>,
  offset: number,
  separatorLength = 1,
): number {
  let cursor = 0;
  for (const output of outputs) {
    const end = cursor + output.text.length;
    if (offset <= end) return output.frame;
    cursor = end + separatorLength;
  }
  return outputs.at(-1)?.frame ?? 0;
}

function parseNativeQuestions(card: string): AskQuestion[] {
  const questions: Array<{ id: string; prompt: string; options: AskOption[] }> = [];
  let current: { id: string; prompt: string; options: AskOption[] } | undefined;
  let lastOption: AskOption | undefined;
  for (const raw of card.split(/\r?\n/u)) {
    const line = raw.replace(/^\s*[│┃]\s*/u, '').replace(/\s*[│┃]\s*$/u, '').trim();
    if (line.length === 0) continue;
    const id = /\[([^\]]+)\](?:\s*·\s*options:\s*\d+)?/u.exec(line);
    if (id !== null) {
      const idValue = id[1];
      if (idValue === undefined) continue;
      current = { id: idValue, prompt: '', options: [] };
      questions.push(current);
      lastOption = undefined;
      continue;
    }
    if (/^(?:╭|╰|├|─|┤|└)/u.test(line)) continue;
    if (current === undefined) continue;
    const option = /^(?:○|◯)\s*(.+)$/u.exec(line);
    if (option !== null) {
      const label = option[1];
      if (label === undefined) continue;
      const item: AskOption = { label };
      current.options.push(item);
      lastOption = item;
      continue;
    }
    if (/^↳\s*/u.test(line) && lastOption !== undefined) {
      const optionIndex = current.options.indexOf(lastOption);
      if (optionIndex >= 0) {
        const updated: AskOption = { ...lastOption, description: line.replace(/^↳\s*/u, '').trim() };
        current.options[optionIndex] = updated;
        lastOption = updated;
      }
      continue;
    }
    if (/^D-[A-Za-z0-9_-]+:/u.test(line)) {
      current.prompt = line;
    } else if (current.prompt.length > 0 && current.options.length === 0) {
      current.prompt += ' ' + line;
    }
  }
  return questions.filter(question => question.prompt.length > 0 && question.options.length > 0);
}

export const HOST_OTHER_OPTION = 'Other (type your own)';

/** Match a canonical selector set, allowing only the host's exact custom-choice suffix. */
export function matchesCanonicalSelectorOptions(
  actual: readonly string[],
  expected: readonly string[],
): boolean {
  const canonical = actual.length === expected.length
    ? actual
    : actual.length === expected.length + 1 && actual.at(-1) === HOST_OTHER_OPTION
      ? actual.slice(0, -1)
      : undefined;
  return canonical !== undefined && canonical.every((option, index) => option === expected[index]);
}

function parseSelectedAskOptions(card: string): { options: string[]; selectedIndex: number } {
  const options: string[] = [];
  let selectedIndex = -1;
  for (const line of card.split(/\r?\n/u)) {
    const match = /(?:^|│)\s*(❯)?\s*○\s+(.+?)(?:\s*│)?\s*$/u.exec(line);
    if (match === null) continue;
    const label = (match[2]?.trim() ?? '').replace(/\s+\(Recommended\)$/u, '');
    if (label.length === 0) continue;
    if (match[1] !== undefined) selectedIndex = options.length;
    options.push(label);
  }
  return { options, selectedIndex };
}

/**
 * Append-only scanner over transcript.jsonl. `refresh()` re-reads only
 * the lines appended since the last scan (O(delta)), keeping repeated
 * polls cheap while the session runs.
 */
export interface TranscriptLogOptions {
  /** Focused-test seam for the existence/open rotation window. */
  readonly open?: (path: string) => number;
}

export interface TranscriptCursor {
  readonly offset: number;
  readonly digest: string | null;
  readonly generation: number;
  readonly frameSerial: number;
}

const TRANSCRIPT_RETAINED_FRAME_LIMIT = 10_000;
const TRANSCRIPT_RETAINED_BYTE_LIMIT = 8 * 1024 * 1024;
const TRANSCRIPT_COMPACTION_THRESHOLD = 1_024;

export class TranscriptLog {
  readonly #path: string;
  readonly #name: string;
  readonly #root: PinnedDirectory | null;
  readonly #open: ((path: string) => number) | null;
  readonly #frames: TranscriptFrame[] = [];
  readonly #frameSerials: number[] = [];
  readonly #frameBytes: number[] = [];
  // Eviction advances this logical head; stale prefixes are compacted occasionally.
  #frameHead = 0;
  #nextFrameSerial = 0;
  #generation = 0;
  #offset = 0;
  #partialTail: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  #identity: { readonly dev: number; readonly ino: number } | null = null;
  #modifiedAt: { readonly mtimeMs: number; readonly ctimeMs: number } | null = null;
  #prefixHasher = createHash('sha256');
  #prefixDigest: string | null = createHash('sha256').digest('hex');
  readonly #digestByOffset = new Map<number, string>([[0, createHash('sha256').digest('hex')]]);
  #closed = false;
  #retainedBytes = 0;

  #updatePrefixDigest(bytes: Uint8Array, endOffset: number): void {
    this.#prefixHasher.update(bytes);
    this.#prefixDigest = this.#prefixHasher.copy().digest('hex');
    this.#digestByOffset.set(endOffset, this.#prefixDigest);
  }

  constructor(transcriptPath: string, options: TranscriptLogOptions = {}) {
    this.#path = resolve(transcriptPath);
    this.#name = basename(this.#path);
    this.#root = options.open === undefined ? pinDirectory(dirname(this.#path)) : null;
    this.#open = options.open ?? null;
  }

  #reset(): void {
    this.#offset = 0;
    this.#partialTail = Buffer.alloc(0);
    this.#frames.length = 0;
    this.#frameSerials.length = 0;
    this.#frameBytes.length = 0;
    this.#frameHead = 0;
    this.#nextFrameSerial = 0;
    this.#generation += 1;
    this.#prefixHasher = createHash('sha256');
    this.#prefixDigest = this.#prefixHasher.copy().digest('hex');
    this.#digestByOffset.clear();
    this.#digestByOffset.set(0, this.#prefixDigest);
    this.#retainedBytes = 0;
  }
  #primePrefix(fd: number, length: number): void {
    if (length <= 0) return;
    const chunkSize = 64 * 1024;
    const buffer = Buffer.allocUnsafe(Math.min(chunkSize, length));
    let offset = 0;
    while (offset < length) {
      const wanted = Math.min(buffer.length, length - offset);
      const count = readSync(fd, buffer, 0, wanted, offset);
      if (count <= 0) break;
      offset += count;
      this.#updatePrefixDigest(buffer.subarray(0, count), offset);
    }
  }
  #digestAtOffset(offset: number): string | null {
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 8 * 1024 * 1024) return null;
    const root = this.#root;
    if (root === null || !pinnedDirectoryIsStable(root)) return null;
    const pinnedFile = openPinnedFile(root, this.#name, fsConstants.O_RDONLY);
    if (pinnedFile === null) return null;
    try {
      const stat = fstatSync(pinnedFile.fd);
      if (!stat.isFile() || stat.size < offset) return null;
      const hasher = createHash('sha256');
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(offset, 1)));
      let read = 0;
      while (read < offset) {
        const count = readSync(pinnedFile.fd, chunk, 0, Math.min(chunk.length, offset - read), read);
        if (count <= 0) return null;
        hasher.update(chunk.subarray(0, count));
        read += count;
      }
      return hasher.digest('hex');
    } catch {
      return null;
    } finally {
      closePinnedFile(pinnedFile);
    }
  }


  #compactRetainedFrames(): void {
    const head = this.#frameHead;
    if (head < TRANSCRIPT_COMPACTION_THRESHOLD || head * 2 < this.#frames.length) return;
    this.#frames.splice(0, head);
    this.#frameSerials.splice(0, head);
    this.#frameBytes.splice(0, head);
    this.#frameHead = 0;
  }

  #retain(frame: TranscriptFrame, lineBytes: number, added: TranscriptFrame[]): void {
    this.#frames.push(frame);
    this.#frameSerials.push(this.#nextFrameSerial);
    this.#frameBytes.push(lineBytes);
    this.#nextFrameSerial += 1;
    this.#retainedBytes += lineBytes;
    added.push(frame);
    while (
      this.#frames.length - this.#frameHead > TRANSCRIPT_RETAINED_FRAME_LIMIT
      || this.#retainedBytes > TRANSCRIPT_RETAINED_BYTE_LIMIT
    ) {
      const removedBytes = this.#frameBytes[this.#frameHead];
      if (removedBytes === undefined) break;
      this.#frameHead += 1;
      this.#retainedBytes -= removedBytes;
    }
    this.#compactRetainedFrames();
  }

  refresh(): TranscriptFrame[] {
    if (this.#closed) return [];
    let fd: number;
    let stat: { readonly dev: number; readonly ino: number; readonly size: number; readonly mtimeMs: number; readonly ctimeMs: number };
    let pinnedFile: ReturnType<typeof openPinnedFile> = null;
    if (this.#open !== null) {
      if (!existsSync(this.#path)) return [];
      try {
        fd = this.#open(this.#path);
      } catch (error) {
        if (error && typeof error === 'object' && (error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
      }
      const raw = fstatSync(fd);
      stat = raw;
    } else {
      const root = this.#root;
      if (root === null || !pinnedDirectoryIsStable(root)) return [];
      pinnedFile = openPinnedFile(root, this.#name, fsConstants.O_RDONLY);
      if (pinnedFile === null) return [];
      fd = pinnedFile.fd;
      const raw = fstatSync(fd);
      stat = raw;
    }
    try {
      const identity = { dev: stat.dev, ino: stat.ino };
      const rewritten = this.#modifiedAt !== null
        && (this.#modifiedAt.mtimeMs !== stat.mtimeMs || this.#modifiedAt.ctimeMs !== stat.ctimeMs)
        && stat.size === this.#offset;
      if (
        (this.#identity !== null
          && (this.#identity.dev !== identity.dev || this.#identity.ino !== identity.ino))
        || stat.size < this.#offset
        || rewritten
      ) {
        this.#reset();
      }
      this.#identity = identity;
      this.#modifiedAt = { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs };
      let startOffset = this.#offset;
      const available = stat.size - startOffset;
      if (available <= 0) return [];
      if (!Number.isSafeInteger(available) || available < 0) {
        this.#reset();
        return [];
      }
      // A live Ask card can remain pending while the OMP PTY emits frequent
      // redraw frames. Retain the same bounded 8 MiB horizon used by the
      // in-memory frame store so a fresh CLI invocation can still replay the
      // card instead of silently trimming it from the 512 KiB tail.
      if (available > TRANSCRIPT_RETAINED_BYTE_LIMIT) {
        this.#reset();
        startOffset = stat.size - TRANSCRIPT_RETAINED_BYTE_LIMIT;
        this.#primePrefix(fd, startOffset);
      }
      const buf = Buffer.allocUnsafe(stat.size - startOffset);
      let read = 0;
      while (read < buf.length) {
        const n = readSync(fd, buf, read, buf.length - read, startOffset + read);
        if (n <= 0) break;
        read += n;
      }
      this.#updatePrefixDigest(buf.subarray(0, read), startOffset + read);
      this.#offset = startOffset + read;
      if (read === 0) return [];
      const combined = this.#partialTail.length === 0
        ? buf.subarray(0, read)
        : Buffer.concat([this.#partialTail, buf.subarray(0, read)]);
      const lastNewline = combined.lastIndexOf(0x0a);
      if (lastNewline === -1) {
        this.#partialTail = combined.length > 65_536
          ? Buffer.from(combined.subarray(combined.length - 65_536))
          : Buffer.from(combined);
        return [];
      }
      const toIngest = combined.subarray(0, lastNewline).toString('utf8');
      this.#partialTail = Buffer.from(combined.subarray(lastNewline + 1));
      if (this.#partialTail.length > 65_536) {
        this.#partialTail = Buffer.from(this.#partialTail.subarray(this.#partialTail.length - 65_536));
      }
      const added: TranscriptFrame[] = [];
      for (const line of toIngest.split('\n')) {
        const trimmed = line.trim();
        if (trimmed.length === 0 || Buffer.byteLength(trimmed, 'utf8') > 512 * 1024) continue;
        try {
          const frame = JSON.parse(trimmed) as TranscriptFrame;
          this.#retain(frame, Buffer.byteLength(trimmed, 'utf8'), added);
        } catch {
          /* skip malformed or partial lines */
        }
      }
      return added;
    } finally {
      if (pinnedFile !== null) {
        closePinnedFile(pinnedFile);
      } else {
        try { closeSync(fd); } catch { /* ignore. */ }
      }
    }
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    if (this.#root !== null) closePinnedDirectory(this.#root);
  }

  transcriptCursor(): TranscriptCursor {
    return {
      offset: this.#offset,
      digest: this.#prefixDigest,
      generation: this.#generation,
      frameSerial: this.#nextFrameSerial,
    };
  }

  hasTerminalAfter(cursor: TranscriptCursor, afterTimestamp?: string): boolean {
    if (this.#closed) return false;
    this.refresh();
    if (this.#generation !== cursor.generation || this.#offset <= cursor.offset) return false;
    if (cursor.digest !== null) {
      const digest = this.#digestByOffset.get(cursor.offset) ?? this.#digestAtOffset(cursor.offset);
      if (digest !== cursor.digest) return false;
    }
    const afterMs = afterTimestamp === undefined ? null : Date.parse(afterTimestamp);
    for (let index = this.#frameHead; index < this.#frameSerials.length; index += 1) {
      const serial = this.#frameSerials[index];
      const frame = this.#frames[index];
      if (serial !== undefined && frame !== undefined && serial >= cursor.frameSerial
        && (frame.t === 'o' || frame.t === 'exit')
        && (afterMs === null || Date.parse(frame.ts) >= afterMs)) return true;
    }
    return false;
  }

  /** All frames ingested so far (call refresh() first for new data). */
  get frames(): readonly TranscriptFrame[] {
    return this.#frameHead === 0 ? this.#frames : this.#frames.slice(this.#frameHead);
  }

  /** All [ask_user] blocks found in the transcript, in order. */
  askBlocks(): AskBlock[] {
    this.refresh();
    return this.#scanBlocks();
  }

  /** First [ask_user] block, or null. */
  detectAskUser(): AskBlock | null {
    const blocks = this.askBlocks();
    return blocks[0] ?? null;
  }

  /** All host `ui.select` checkpoint cards found in the transcript. */
  selectedAskBlocks(): SelectedAskBlock[] {
    this.refresh();
    return this.#scanSelectedBlocks();
  }

  /**
   * Return all host selector cards that have not received a terminal submit
   * yet. Navigation events (ArrowUp/ArrowDown) keep a card pending; only the
   * final Enter (marked by the server as is_final_submit) closes it.
   */
  pendingSelectedAskBlocks(): SelectedAskBlock[] {
    return this.selectedAskBlocks().filter((block) => !this.#hasFinalInputAfter(block.frameEnd));
  }

  /** Return the latest host selector card that is still pending. */
  pendingSelectedAsk(): SelectedAskBlock | null {
    return this.pendingSelectedAskBlocks().at(-1) ?? null;
  }

  /** First host `ui.select` checkpoint card, or null. */
  detectSelectedAsk(): SelectedAskBlock | null {
    const blocks = this.selectedAskBlocks();
    return blocks[0] ?? null;
  }

  #hasFinalInputAfter(frameSerial: number): boolean {
    for (let index = this.#frameHead; index < this.#frames.length; index += 1) {
      const serial = this.#frameSerials[index];
      const frame = this.#frames[index];
      if (serial === undefined || serial < frameSerial || frame?.t !== 'i') continue;
      if (frame.is_final_submit === true) return true;
      // Older transcript writers did not persist input metadata. A real
      // Enter remains unambiguous there because selector navigation bytes do
      // not contain CR/LF.
      if (frame.is_final_submit === undefined && /[\r\n]/u.test(frame.d)) return true;
    }
    return false;
  }

  #scanBlocks(): AskBlock[] {
    const legacy = this.#scanLegacyBlocks();
    const native = this.#scanNativeBlocks();
    const surfaceOrder: Readonly<Record<AskBlock['surface'], number>> = {
      legacy: 0,
      native: 1,
    };
    const merged = [...legacy, ...native].sort((a, b) => {
      const startOrder = a.frameStart - b.frameStart;
      if (startOrder !== 0) return startOrder;
      const endOrder = a.frameEnd - b.frameEnd;
      if (endOrder !== 0) return endOrder;
      const surfaceTie = surfaceOrder[a.surface] - surfaceOrder[b.surface];
      if (surfaceTie !== 0) return surfaceTie;
      return askBlockPayloadDigest(a).localeCompare(askBlockPayloadDigest(b));
    });
    return merged.map((block, position) => ({ ...block, index: position + 1 }));
  }

  #scanLegacyBlocks(): AskBlock[] {
    const blocks: AskBlock[] = [];
    let inBlock = false;
    let title = '';
    let options: string[] = [];
    let frameStart: number | undefined;

    const flush = (frameEnd: number): void => {
      if (!inBlock || frameStart === undefined) return;
      const question: AskQuestion = {
        id: 'legacy-' + String(frameStart),
        prompt: title.replace(/^\s*\[ask_user\]\s*/u, '').trim(),
        options: options.map(option => ({ label: option })),
      };
      blocks.push({
        index: 0,
        title,
        options,
        surface: 'legacy',
        questions: [question],
        frameStart,
        frameEnd,
      });
      inBlock = false;
      frameStart = undefined;
    };

    for (let fi = this.#frameHead; fi < this.#frames.length; fi += 1) {
      const frame = this.#frames[fi];
      const serial = this.#frameSerials[fi];
      if (frame === undefined || serial === undefined) continue;
      if (frame.t !== 'o' || typeof frame.d !== 'string') {
        flush(serial);
        continue;
      }
      const linesRaw = stripAnsi(frame.d).split('\n');
      const lines = linesRaw[linesRaw.length - 1] === '' ? linesRaw.slice(0, -1) : linesRaw;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0) {
          if (inBlock) flush(serial);
          continue;
        }
        if (line.includes('[ask_user]')) {
          flush(serial);
          inBlock = true;
          title = line;
          options = [];
          frameStart = serial;
          continue;
        }
        if (inBlock) {
          if (OPTION_LINE_RE.test(line)) {
            options.push(line);
            continue;
          }
          flush(serial);
        }
      }
    }
    flush(this.#nextFrameSerial);
    return blocks;
  }

  #scanNativeBlocks(): AskBlock[] {
    const outputs: Array<{ readonly frame: number; readonly text: string }> = [];
    for (let fi = this.#frameHead; fi < this.#frames.length; fi += 1) {
      const frame = this.#frames[fi];
      const serial = this.#frameSerials[fi];
      if (frame !== undefined && serial !== undefined && frame.t === 'o' && typeof frame.d === 'string') {
        outputs.push({ frame: serial, text: stripAnsi(frame.d) });
      }
    }
    const stream = outputs.map(output => output.text).join('\n');
    const blocks: AskBlock[] = [];
    const marker = /╭───\s*Ask\s+(\d+)\s+questions?\b/gu;
    let match: RegExpExecArray | null;
    let lastSignature = '';
    let lastFrame = -Infinity;
    while ((match = marker.exec(stream)) !== null) {
      const close = stream.indexOf('╰───', marker.lastIndex);
      if (close < 0) break;
      const end = stream.indexOf('╯', close);
      if (end < 0) break;
      const card = stream.slice(match.index, end + 1);
      const questions = parseNativeQuestions(card);
      if (questions.length === 0) continue;
      const signature = questions.map(question => question.id + ':' + question.prompt + ':' + question.options.map(option => option.label).join('|')).join('||');
      const frameStart = frameAtOffset(outputs, match.index);
      if (signature === lastSignature && frameStart - lastFrame < 100) continue;
      lastSignature = signature;
      lastFrame = frameStart;
      const context = stream.slice(Math.max(0, match.index - 8_000), match.index);
      const compatibility = /compatibility|imported\s+specification\s+checkpoint/iu.test(context);
      const title = (compatibility ? 'compatibility checkpoint: ' : 'native Ask: ')
        + questions.map(question => question.prompt).join(' / ');
      blocks.push({
        index: 0,
        title,
        options: questions.flatMap(question => question.options.map(option => option.label)),
        surface: 'native',
        questions,
        frameStart,
        frameEnd: frameAtOffset(outputs, end) + 1,
      });
    }
    return blocks;
  }

  #scanSelectedBlocks(): SelectedAskBlock[] {
    const outputs: Array<{ readonly frame: number; readonly text: string }> = [];
    const rawOutputs: string[] = [];
    for (let fi = this.#frameHead; fi < this.#frames.length; fi += 1) {
      const frame = this.#frames[fi];
      const serial = this.#frameSerials[fi];
      if (frame !== undefined && serial !== undefined && frame.t === 'o' && typeof frame.d === 'string') {
        rawOutputs.push(frame.d);
        outputs.push({ frame: serial, text: stripAnsi(frame.d) });
      }
    }
    const stream = stripAnsi(rawOutputs.join(''));
    const blocks: SelectedAskBlock[] = [];
    // The host selector card has one dash (`╭─ Ask`), while the native
    // multi-question Ask card has three (`╭─── Ask N questions`).
    const marker = /╭─\s+Ask\b/gu;
    let match: RegExpExecArray | null;
    let lastSignature = '';
    let lastFrame = -Infinity;
    while ((match = marker.exec(stream)) !== null) {
      const close = stream.indexOf('╰─', marker.lastIndex);
      if (close < 0) break;
      const end = stream.indexOf('╯', close);
      if (end < 0) break;
      const card = stream.slice(match.index, end + 1);
      const parsed = parseSelectedAskOptions(card);
      if (parsed.options.length === 0 || parsed.selectedIndex < 0) continue;
      const frameStart = frameAtOffset(outputs, match.index, 0);
      const signature = parsed.options.join('|') + ':' + String(parsed.selectedIndex);
      if (signature === lastSignature && frameStart - lastFrame < 100) continue;
      lastSignature = signature;
      lastFrame = frameStart;
      // The imported compatibility selector is a compact canonical packet:
      // its PTY card may omit the checkpoint prose (the stage line is visually
      // truncated), but it retains the semantic workflow and decision set.
      // Classify that exact packet rather than relying on surrounding prose.
      const importedCompatibility = matchesCanonicalSelectorOptions(
        parsed.options,
        ['approve_continue', 'request_changes', 'approve_stop'],
      ) && /\bworkflow:\s*spec-import\b/iu.test(card);
      const compatibility = importedCompatibility
        || /compatibility|imported\s+specification\s+checkpoint/iu.test(card);
      // Retain the host-authored semantic context from the card. The short
      // surface label alone cannot distinguish concurrent feature/run/phase
      // checkpoints; callers must bind a selected card by this context, not
      // by its option count or transcript order.
      const contextLines = card
        .split(/\r?\n/u)
        .map((line) => line.replace(/^\s*[│|]\s?/u, '').replace(/[│|]\s*$/u, '').trim())
        .filter((line) => line.length > 0 && !/^(?:╭|╰|├|─|Enter select|\S*\s*[○❯])/u.test(line));
      const semanticContext = contextLines.filter((line) => /workflow:|checkpoint|feature|run[_ ]?key|stage(?:[_ ]id|[_ ]?cursor)|mapping|cto[_ -]?run/iu.test(line));
      const title = (compatibility ? 'compatibility checkpoint' : 'selected checkpoint')
        + (semanticContext.length === 0 ? '' : `: ${semanticContext.join(' | ')}`);
      blocks.push({
        index: 0,
        title,
        options: parsed.options,
        selectedIndex: parsed.selectedIndex,
        surface: 'selector',
        frameStart,
        frameEnd: frameAtOffset(outputs, end, 0) + 1,
      });
    }
    return blocks.map((block, index) => ({ ...block, index: index + 1 }));
  }


}
/* ------------------------------------------------------------------ */
/* AskStateTracker — unanswered [ask_user] blocks + double-answer guard */
/* ------------------------------------------------------------------ */

export interface AskStateRecord {
  readonly ts: string;
  readonly answer?: string;
  readonly block_title: string;
  readonly block_index: number;
  /** Stable block identity; retained ordinals are intentionally not persisted as keys. */
  readonly block_surface?: AskBlock['surface'];
  readonly status?: 'reserved' | 'committed' | 'cancelled';
  readonly reservation_id?: string;
  readonly session_id?: string;
  readonly owner_pid?: number;
  readonly owner_start?: string;
  readonly lease_expires_at?: string;
  readonly transcript_offset?: number;
  readonly transcript_digest?: string | null;
  readonly transcript_generation?: number;
  readonly transcript_frame_serial?: number;
  readonly transcript_frame_start?: number;
  readonly content_digest?: string;
}

export interface AskStateTrackerOptions {
  readonly sessionId?: string;
  readonly leaseMs?: number;
}
interface ReservationLease {
  readonly id: string;
  readonly sessionId: string | null;
  readonly ownerPid: number;
  readonly ownerStart: string;
  readonly expiresAt: string;
  readonly transcriptOffset: number;
  readonly transcriptDigest: string | null;
  readonly transcriptGeneration: number;
  readonly transcriptFrameSerial: number;
  readonly contentDigest: string;
}
interface DeliveryStep {
  readonly ts: string;
  readonly status: 'delivery_prepared' | 'delivered';
  readonly stepIndex: number;
  readonly stepCount: number;
  readonly isFinalSubmit: boolean;
  readonly sequence: number | null;
}
interface DeliveryRecovery {
  readonly id: string;
  readonly status: 'delivery_prepared' | 'delivered';
  readonly contentDigest: string | null;
  readonly cursor: TranscriptCursor | null;
  readonly steps: readonly DeliveryStep[];
  readonly finalDeliveredAt: string | null;
}

export interface AnswerReservation {
  readonly id: string;
  readonly answer: string;
  readonly block: AskBlock;
  readonly sessionId: string | null;
  readonly ownerPid: number;
  readonly ownerStart: string;
  readonly leaseExpiresAt: string;
  readonly transcriptOffset: number;
  readonly transcriptDigest: string | null;
  readonly transcriptGeneration: number;
  readonly transcriptFrameSerial: number;
  readonly contentDigest: string;
}
export type ReservationResult =
  | { readonly ok: true; readonly reservation: AnswerReservation }
  | {
    readonly ok: false;
    readonly reason: 'no-pending' | 'already-answered' | 'transcript-advanced' | 'persistence-error' | 'delivery-ambiguous';
  };

export type AnswerResult =
  | { readonly ok: true; readonly block: AskBlock }
  | {
    readonly ok: false;
    readonly reason:
      | 'no-pending'
      | 'already-answered'
      | 'transcript-advanced'
      | 'persistence-error'
      | 'delivery-ambiguous'
      | 'delivery-not-observed'
      | 'native-multi-question-requires-explicit-answers'
      | 'native-answer-requires-native-ask'
      | 'native-answer-missing-question'
      | 'native-answer-unexpected-question'
      | 'native-answer-invalid-option';
  };

export type NativeAnswerMap = Readonly<Record<string, string>>;

/**
 * Tracks unanswered [ask_user] blocks across the transcript and the
 * ask-state.jsonl answer log. The answer ledger is guarded by an exclusive
 * lock: pending detection, transcript re-read, and append happen as one
 * descriptor-pinned operation.
 */
export class AskStateTracker {
  readonly #log: TranscriptLog;
  readonly #askStatePath: string;
  readonly #askStateName: string;
  readonly #deliveryName = 'delivery.jsonl';
  readonly #askStateRoot: PinnedDirectory | null;
  readonly #sessionId: string | null;
  readonly #ambiguousDelivery: Set<string> = new Set();
  readonly #deliveryRecovery: Map<string, DeliveryRecovery> = new Map();
  readonly #deliveryStatus: Map<string, 'delivery_prepared' | 'delivered'> = new Map();
  readonly #deliverySequences: Map<string, DeliveryStep[]> = new Map();
  readonly #ownerPid = process.pid;
  readonly #ownerStart: string | null;
  readonly #leaseMs: number;
  readonly #answered: Set<string> = new Set();
  readonly #reserved: Map<string, ReservationLease> = new Map();
  #answersReadable = true;
  #deliveryReadable = true;
  #pending: AskBlock | null = null;
  #pendingCursor: TranscriptCursor | null = null;
  #closed = false;

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#log.close();
    if (this.#askStateRoot !== null) closePinnedDirectory(this.#askStateRoot);
  }
  constructor(
    transcriptPath: string,
    askStatePath: string,
    options: AskStateTrackerOptions = {},
  ) {
    this.#log = new TranscriptLog(transcriptPath);
    this.#askStatePath = resolve(askStatePath);
    this.#askStateName = basename(this.#askStatePath);
    this.#askStateRoot = pinDirectory(dirname(this.#askStatePath));
    this.#sessionId = typeof options.sessionId === 'string' && options.sessionId.length > 0
      ? options.sessionId
      : null;
    const leaseMs = options.leaseMs ?? 120_000;
    this.#leaseMs = Number.isSafeInteger(leaseMs) && leaseMs >= 1_000 && leaseMs <= 10 * 60_000
      ? leaseMs
      : 120_000;
    this.#ownerStart = processStartIdentity(this.#ownerPid);
    this.#reloadAnswers();
  }


  #recordMatchesCurrent(
    rec: Partial<AskStateRecord>,
    key: string | null,
    currentContentDigests: ReadonlyMap<string, string>,
  ): boolean {
    if (this.#sessionId === null) return true;
    if (rec.status === 'committed' && rec.session_id !== this.#sessionId) {
      return key !== null
        && typeof rec.content_digest === 'string'
        && currentContentDigests.get(key) === rec.content_digest;
    }
    if (rec.session_id !== this.#sessionId) return false;
    if (rec.status !== 'reserved') return true;
    if (rec.owner_pid !== this.#ownerPid || rec.owner_start !== this.#ownerStart) {
      if (typeof rec.owner_pid !== 'number' || !Number.isSafeInteger(rec.owner_pid) || rec.owner_pid <= 0
        || typeof rec.owner_start !== 'string' || rec.owner_start.length === 0) return false;
      try {
        process.kill(rec.owner_pid, 0);
        if (processStartIdentity(rec.owner_pid) !== rec.owner_start) return false;
      } catch {
        return false;
      }
    }
    return true;
  }
  static #key(block: AskBlock): string {
    return `${block.surface}:${block.frameStart}:${askBlockPayloadDigest(block)}`;
  }
  static #contentDigest(block: AskBlock): string {
    return askBlockPayloadDigest(block);
  }
  #reloadDelivery(): void {
    this.#deliveryStatus.clear();
    this.#deliverySequences.clear();
    this.#deliveryReadable = true;
    const root = this.#askStateRoot;
    if (root === null || !pinnedDirectoryIsStable(root)) {
      this.#deliveryReadable = false;
      return;
    }
    const bytes = readPinnedFileFull(root, this.#deliveryName, 8 * 1024 * 1024);
    if (bytes === null) {
      try {
        const info = lstatSync(join(root.lexicalPath, this.#deliveryName));
        if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 8 * 1024 * 1024) {
          this.#deliveryReadable = false;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.#deliveryReadable = false;
      }
      return;
    }
    for (const line of bytes.toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const rec = JSON.parse(line) as Record<string, unknown>;
        const sessionId = rec['session_id'];
        const reservationId = rec['reservation_id'];
        const status = rec['status'];
        const ts = typeof rec['ts'] === 'string' ? rec['ts'] : '';
        const rawStepIndex = rec['step_index'];
        const rawStepCount = rec['step_count'];
        const rawIsFinalSubmit = rec['is_final_submit'];
        const rawSequence = rec['sequence'];
        const stepIndex = rawStepIndex === undefined
          ? 1
          : typeof rawStepIndex === 'number' && Number.isSafeInteger(rawStepIndex) ? rawStepIndex : null;
        const stepCount = rawStepCount === undefined
          ? 1
          : typeof rawStepCount === 'number' && Number.isSafeInteger(rawStepCount) ? rawStepCount : null;
        const isFinalSubmit = rawIsFinalSubmit === undefined ? false : rawIsFinalSubmit;
        const sequence = rawSequence === null || rawSequence === undefined
          ? null
          : typeof rawSequence === 'number' && Number.isSafeInteger(rawSequence) && rawSequence > 0 ? rawSequence : null;
        if ((this.#sessionId === null || sessionId === this.#sessionId)
          && typeof reservationId === 'string'
          && (status === 'delivery_prepared' || status === 'delivered')
          && ts.length > 0
          && stepIndex !== null && stepCount !== null
          && stepIndex >= 1 && stepCount >= 1 && stepIndex <= stepCount
          && typeof isFinalSubmit === 'boolean'
          && (rawSequence === null || rawSequence === undefined || sequence !== null)) {
          const step: DeliveryStep = {
            ts,
            status,
            stepIndex,
            stepCount,
            isFinalSubmit,
            sequence,
          };
          const steps = this.#deliverySequences.get(reservationId) ?? [];
          steps.push(step);
          this.#deliverySequences.set(reservationId, steps);
          this.#deliveryStatus.set(reservationId, status);
        }
      } catch {
        /* Ignore malformed delivery records. */
      }
    }
  }
  #deliverySequenceState(reservationId: string): 'none' | 'partial' | 'delivered' {
    const steps = this.#deliverySequences.get(reservationId);
    if (steps === undefined || steps.length === 0) return 'none';
    const stepCount = steps[0]?.stepCount ?? 0;
    if (stepCount < 1 || steps.some(step => step.stepCount !== stepCount
      || (step.isFinalSubmit && step.stepIndex !== stepCount))) return 'partial';
    for (let index = 1; index <= stepCount; index += 1) {
      const delivered = steps.some(step => step.stepIndex === index && step.status === 'delivered');
      if (!delivered) return 'partial';
    }
    const final = steps.some(step => step.stepIndex === stepCount && step.status === 'delivered' && step.isFinalSubmit);
    return final ? 'delivered' : 'partial';
  }
  #finalDeliveryTimestamp(steps: readonly DeliveryStep[]): string | null {
    for (let index = steps.length - 1; index >= 0; index -= 1) {
      const step = steps[index];
      if (step !== undefined && step.status === 'delivered' && step.isFinalSubmit) return step.ts;
    }
    return null;
  }

  #reloadAnswers(): boolean {
    this.#answered.clear();
    this.#reserved.clear();
    this.#ambiguousDelivery.clear();
    this.#deliveryRecovery.clear();
    this.#reloadDelivery();
    if (!this.#deliveryReadable) {
      this.#answersReadable = false;
      return false;
    }
    const root = this.#askStateRoot;
    if (root === null || !pinnedDirectoryIsStable(root)) {
      this.#answersReadable = false;
      return false;
    }
    const bytes = readPinnedFileFull(root, this.#askStateName, 8 * 1024 * 1024);
    if (bytes === null) {
      try {
        const info = lstatSync(join(root.lexicalPath, this.#askStateName));
        this.#answersReadable = info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 8 * 1024 * 1024;
      } catch (error) {
        this.#answersReadable = (error as NodeJS.ErrnoException).code === 'ENOENT';
      }
      return this.#answersReadable;
    }
    this.#answersReadable = true;
    const now = Date.now();
    const currentBlocks = this.#log.askBlocks();
    const currentContentDigests = new Map<string, string>(
      currentBlocks.map(block => [AskStateTracker.#key(block), AskStateTracker.#contentDigest(block)]),
    );
    const currentKeysByIdentity = new Map<string, string>(
      currentBlocks.map(block => [
        `${block.surface}:${block.frameStart}:${block.title}`,
        AskStateTracker.#key(block),
      ]),
    );
    for (const line of bytes.toString('utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const rec = JSON.parse(line) as Partial<AskStateRecord>;
        const key = (rec.block_surface === 'legacy' || rec.block_surface === 'native')
          && typeof rec.block_title === 'string'
          && Number.isSafeInteger(rec.transcript_frame_start)
          && rec.transcript_frame_start !== undefined
          && rec.transcript_frame_start >= 0
          && typeof rec.content_digest === 'string'
          && /^[0-9a-f]{64}$/u.test(rec.content_digest)
          ? `${rec.block_surface}:${rec.transcript_frame_start}:${rec.content_digest}`
          : null;
        if (!this.#recordMatchesCurrent(rec, key, currentContentDigests)) {
          if (key !== null && rec.status === 'reserved'
            && rec.session_id === this.#sessionId
            && typeof rec.reservation_id === 'string') {
            const status = this.#deliveryStatus.get(rec.reservation_id);
            const steps = this.#deliverySequences.get(rec.reservation_id);
            if (status !== undefined && steps !== undefined) {
              const identity = `${rec.block_surface}:${rec.transcript_frame_start}:${rec.block_title}`;
              const recoveryKey = currentKeysByIdentity.get(identity) ?? key;
              this.#ambiguousDelivery.add(recoveryKey);
              const offset = rec.transcript_offset;
              const generation = rec.transcript_generation;
              const frameSerial = rec.transcript_frame_serial;
              this.#deliveryRecovery.set(recoveryKey, {
                id: rec.reservation_id,
                status,
                contentDigest: typeof rec.content_digest === 'string' ? rec.content_digest : null,
                finalDeliveredAt: this.#finalDeliveryTimestamp(steps),
                steps,
                cursor: Number.isSafeInteger(offset) && offset !== undefined && offset >= 0
                  && Number.isSafeInteger(generation) && generation !== undefined && generation >= 0
                  && Number.isSafeInteger(frameSerial) && frameSerial !== undefined && frameSerial >= 0
                  ? {
                      offset,
                      digest: rec.transcript_digest ?? null,
                      generation,
                      frameSerial,
                    }
                  : null,
              });
            }
          }
          continue;
        }
        if (key !== null) {
          if (rec.status === 'reserved' && typeof rec.reservation_id === 'string') {
            const expiresAt = typeof rec.lease_expires_at === 'string' ? rec.lease_expires_at : '';
            const ownerPid = rec.owner_pid;
            const ownerStart = rec.owner_start;
            const offset = rec.transcript_offset;
            const digest = rec.transcript_digest;
            const generation = rec.transcript_generation;
            const frameSerial = rec.transcript_frame_serial;
            const leaseTime = Date.parse(expiresAt);
              const contentDigest = rec.content_digest;
              if (typeof contentDigest !== 'string' || !/^[0-9a-f]{64}$/u.test(contentDigest)) continue;
            if (
              expiresAt.length > 0
              && Number.isSafeInteger(leaseTime)
              && leaseTime > now
              && Number.isSafeInteger(ownerPid)
              && ownerPid !== undefined
              && ownerPid > 0
              && typeof ownerStart === 'string'
              && ownerStart.length > 0
              && Number.isSafeInteger(offset)
              && offset !== undefined
              && offset >= 0
              && (digest === null || typeof digest === 'string')
              && Number.isSafeInteger(generation)
              && generation !== undefined
              && generation >= 0
              && Number.isSafeInteger(frameSerial)
              && frameSerial !== undefined
              && frameSerial >= 0
            ) {
              this.#reserved.set(key, {
                id: rec.reservation_id,
                sessionId: typeof rec.session_id === 'string' && rec.session_id.length > 0 ? rec.session_id : null,
                ownerPid,
                ownerStart,
                expiresAt,
                transcriptOffset: offset,
                transcriptDigest: digest ?? null,
                transcriptGeneration: generation,
                transcriptFrameSerial: frameSerial,
                contentDigest,
              });
            }
          } else if (rec.status === 'cancelled') {
            this.#reserved.delete(key);
          } else {
            this.#reserved.delete(key);
            this.#answered.add(key);
          }
        }
      } catch {
        /* skip corrupt lines */
      }
    }
    return true;
  }

  /** True when the block is still actionable: latest ask and unchanged payload. */
  #blockOpen(block: AskBlock, all: readonly AskBlock[]): boolean {
    const key = AskStateTracker.#key(block);
    if (this.#answered.has(key) || this.#reserved.has(key)) return false;
    const last = all[all.length - 1];
    return last !== undefined
      && last.index === block.index
      && last.surface === block.surface
      && last.frameStart === block.frameStart
      && AskStateTracker.#key(last) === key
      && AskStateTracker.#contentDigest(last) === AskStateTracker.#contentDigest(block);
  }

  #latestPending(all: readonly AskBlock[]): AskBlock | null {
    const open = all.filter(block => this.#blockOpen(block, all));
    return open[open.length - 1] ?? null;
  }
  #finalizeRecoveredDelivery(block: AskBlock): boolean {
    const key = AskStateTracker.#key(block);
    const recovery = this.#deliveryRecovery.get(key);
    if (recovery === undefined || recovery.status !== 'delivered'
      || recovery.contentDigest !== AskStateTracker.#contentDigest(block)
      || this.#deliverySequenceState(recovery.id) !== 'delivered'
      || recovery.cursor === null || recovery.finalDeliveredAt === null
      || !this.#log.hasTerminalAfter(recovery.cursor, recovery.finalDeliveredAt)) return false;
    const root = this.#askStateRoot;
    if (root === null || !appendPinnedFile(root, this.#askStateName, Buffer.from(JSON.stringify({
      ts: new Date().toISOString(),
      block_title: block.title,
      block_index: block.index,
      block_surface: block.surface,
      transcript_frame_start: block.frameStart,
      content_digest: recovery.contentDigest,
      status: 'committed',
      reservation_id: recovery.id,
      session_id: this.#sessionId ?? undefined,
    }) + '\n', 'utf8'))) return false;
    this.#answered.add(key);
    this.#ambiguousDelivery.delete(key);
    this.#deliveryRecovery.delete(key);
    return true;
  }


  /**
   * Recompute and return the current pending [ask_user] block — the
   * latest unanswered ask — or null.
   */
  pendingBlock(): AskBlock | null {
    this.#log.refresh();
    if (!this.#reloadAnswers()) {
      this.#pending = null;
      this.#pendingCursor = null;
      return null;
    }
    const all = this.#log.askBlocks();
    this.#pending = this.#latestPending(all);
    this.#pendingCursor = this.#log.transcriptCursor();
    return this.#pending;
  }

  /** The block captured by the most recent pendingBlock() call. */
  get pending(): AskBlock | null {
    return this.#pending;
  }
  /** True after terminal output or lifecycle evidence follows the reserved Ask. */
  observedAfter(value: AskBlock | AnswerReservation): boolean {
    const cursor: TranscriptCursor | null = 'transcriptOffset' in value
      ? {
          offset: value.transcriptOffset,
          digest: value.transcriptDigest,
          generation: value.transcriptGeneration,
          frameSerial: value.transcriptFrameSerial,
        }
      : this.#pendingCursor;
    return cursor !== null && this.#log.hasTerminalAfter(cursor);
  }

  #withAnswerLock(
    captured: AskBlock | null,
    operation: (block: AskBlock | null, all: readonly AskBlock[]) => AnswerResult,
  ): AnswerResult {
    const root = this.#askStateRoot;
    if (root === null) return { ok: false, reason: 'persistence-error' };
    try {
      return withPinnedExclusiveLock(root, '.ask-state.lock', () => {
        if (!this.#reloadAnswers()) return { ok: false, reason: 'persistence-error' };
        this.#log.refresh();
        const all = this.#log.askBlocks();
        return operation(captured, all);
      });
    } catch {
      return { ok: false, reason: 'persistence-error' };
    }
  }

  #withReservationLock(
    captured: AskBlock | null,
    operation: (block: AskBlock | null, all: readonly AskBlock[]) => ReservationResult,
  ): ReservationResult {
    const root = this.#askStateRoot;
    if (root === null) return { ok: false, reason: 'persistence-error' };
    try {
      return withPinnedExclusiveLock(root, '.ask-state.lock', () => {
        if (!this.#reloadAnswers()) return { ok: false, reason: 'persistence-error' };
        this.#log.refresh();
        return operation(captured, this.#log.askBlocks());
      });
    } catch {
      return { ok: false, reason: 'persistence-error' };
    }
  }
  #recordReservation(block: AskBlock, text: string): ReservationResult {
    const contentDigest = AskStateTracker.#contentDigest(block);
    if (this.#ownerStart === null) return { ok: false, reason: 'persistence-error' };
    const cursor = this.#log.transcriptCursor();
    const id = randomUUID();
    const leaseExpiresAt = new Date(Date.now() + this.#leaseMs).toISOString();
    const rec: AskStateRecord = {
      ts: new Date().toISOString(),
      answer: text,
      block_title: block.title,
      block_index: block.index,
      block_surface: block.surface,
      transcript_frame_start: block.frameStart,
      content_digest: contentDigest,
      status: 'reserved',
      reservation_id: id,
      session_id: this.#sessionId ?? undefined,
      owner_pid: this.#ownerPid,
      owner_start: this.#ownerStart,
      lease_expires_at: leaseExpiresAt,
      transcript_offset: cursor.offset,
      transcript_digest: cursor.digest,
      transcript_generation: cursor.generation,
      transcript_frame_serial: cursor.frameSerial,
    };
    const root = this.#askStateRoot;
    if (root === null || !this.#answersReadable
      || !appendPinnedFile(root, this.#askStateName, Buffer.from(JSON.stringify(rec) + '\n', 'utf8'))) {
      return { ok: false, reason: 'persistence-error' };
    }
    const lease: ReservationLease = {
      id,
      sessionId: this.#sessionId,
      contentDigest,
      ownerPid: this.#ownerPid,
      ownerStart: this.#ownerStart,
      expiresAt: leaseExpiresAt,
      transcriptOffset: cursor.offset,
      transcriptDigest: cursor.digest,
      transcriptGeneration: cursor.generation,
      transcriptFrameSerial: cursor.frameSerial,
    };
    this.#reserved.set(AskStateTracker.#key(block), lease);
    return {
      ok: true,
      reservation: {
        id,
        answer: text,
        block,
        sessionId: this.#sessionId,
        ownerPid: this.#ownerPid,
        ownerStart: this.#ownerStart,
        leaseExpiresAt,
        transcriptOffset: cursor.offset,
        transcriptDigest: cursor.digest,
        transcriptGeneration: cursor.generation,
        contentDigest,
        transcriptFrameSerial: cursor.frameSerial,
      },
    };
  }

  /** Reserve the current Ask without marking it answered. */
  reserve(text: string): ReservationResult {
    const captured = this.#pending;
    return this.#withReservationLock(captured, (candidate, all) => {
      const block = candidate ?? this.#latestPending(all);
      if (block === null) return { ok: false, reason: all.length > 0 ? 'already-answered' : 'no-pending' };
      const key = AskStateTracker.#key(block);
      if (this.#finalizeRecoveredDelivery(block)) return { ok: false, reason: 'already-answered' };
      if (this.#ambiguousDelivery.has(key)) return { ok: false, reason: 'delivery-ambiguous' };
      if (!this.#blockOpen(block, all)) {
        return {
          ok: false,
          reason: this.#answered.has(AskStateTracker.#key(block)) ? 'already-answered' : 'transcript-advanced',
        };
      }
      return this.#recordReservation(block, text);
    });
  }
  #reservationOwns(key: string, reservation: AnswerReservation): boolean {
    const lease = this.#reserved.get(key);
    return lease !== undefined
      && lease.id === reservation.id
      && lease.sessionId === reservation.sessionId
      && lease.ownerPid === reservation.ownerPid
      && lease.ownerStart === reservation.ownerStart
      && lease.expiresAt === reservation.leaseExpiresAt
      && lease.transcriptOffset === reservation.transcriptOffset
      && lease.transcriptDigest === reservation.transcriptDigest
      && lease.transcriptGeneration === reservation.transcriptGeneration
      && lease.transcriptFrameSerial === reservation.transcriptFrameSerial
      && lease.contentDigest === reservation.contentDigest
      && Date.parse(lease.expiresAt) > Date.now();
  }
  /** Revalidate reservation ownership and that the same Ask is still latest. */
  revalidateReservation(reservation: AnswerReservation): boolean {
    const root = this.#askStateRoot;
    if (root === null) return false;
    try {
      return withPinnedExclusiveLock(root, '.ask-state.lock', () => {
        if (!this.#reloadAnswers()) return false;
        this.#log.refresh();
        const all = this.#log.askBlocks();
        const latest = all.at(-1);
        return latest !== undefined
          && AskStateTracker.#key(latest) === AskStateTracker.#key(reservation.block)
          && AskStateTracker.#contentDigest(latest) === reservation.contentDigest
          && !this.#log.hasTerminalAfter({
            offset: reservation.transcriptOffset,
            digest: reservation.transcriptDigest,
            generation: reservation.transcriptGeneration,
            frameSerial: reservation.transcriptFrameSerial,
          })
          && this.#reservationOwns(AskStateTracker.#key(latest), reservation);
      });
    } catch {
      return false;
    }
  }

  /** Durable server receipt state for a reservation, refreshed from delivery.jsonl. */
  deliveryState(
    reservation: AnswerReservation,
  ): 'none' | 'delivery_prepared' | 'delivered' | 'delivery-ambiguous' | 'unreadable' {
    this.#reloadDelivery();
    if (!this.#deliveryReadable) return 'unreadable';
    const sequenceState = this.#deliverySequenceState(reservation.id);
    if (sequenceState === 'partial') return 'delivery-ambiguous';
    if (sequenceState === 'delivered') return 'delivered';
    return this.#deliveryStatus.get(reservation.id) ?? 'none';
  }

  refreshReservation(reservation: AnswerReservation): AnswerReservation | null {
    const root = this.#askStateRoot;
    if (root === null) return null;
    const key = AskStateTracker.#key(reservation.block);
    try {
      return withPinnedExclusiveLock(root, '.ask-state.lock', () => {
        if (!this.#reloadAnswers()) return null;
        this.#log.refresh();
        const all = this.#log.askBlocks();
        const latest = all.at(-1);
        if (latest === undefined
          || AskStateTracker.#key(latest) !== key
          || AskStateTracker.#contentDigest(latest) !== reservation.contentDigest
          || !this.#reservationOwns(key, reservation)
          || this.#log.hasTerminalAfter({
            offset: reservation.transcriptOffset,
            digest: reservation.transcriptDigest,
            generation: reservation.transcriptGeneration,
            frameSerial: reservation.transcriptFrameSerial,
          })
          || this.#ownerStart === null) return null;
        const cursor = this.#log.transcriptCursor();
        if (cursor.offset === reservation.transcriptOffset
          && cursor.digest === reservation.transcriptDigest
          && cursor.generation === reservation.transcriptGeneration
          && cursor.frameSerial === reservation.transcriptFrameSerial) return reservation;
        const leaseExpiresAt = reservation.leaseExpiresAt;
        const rec: AskStateRecord = {
          ts: new Date().toISOString(),
          answer: reservation.answer,
          block_title: latest.title,
          block_index: latest.index,
          block_surface: latest.surface,
          transcript_frame_start: latest.frameStart,
          content_digest: reservation.contentDigest,
          status: 'reserved',
          reservation_id: reservation.id,
          session_id: reservation.sessionId ?? undefined,
          owner_pid: reservation.ownerPid,
          owner_start: reservation.ownerStart,
          lease_expires_at: leaseExpiresAt,
          transcript_offset: cursor.offset,
          transcript_digest: cursor.digest,
          transcript_generation: cursor.generation,
          transcript_frame_serial: cursor.frameSerial,
        };
        if (!this.#answersReadable
          || !appendPinnedFile(root, this.#askStateName, Buffer.from(JSON.stringify(rec) + '\n', 'utf8'))) return null;
        const refreshed: AnswerReservation = {
          ...reservation,
          block: latest,
          transcriptOffset: cursor.offset,
          transcriptDigest: cursor.digest,
          transcriptGeneration: cursor.generation,
          transcriptFrameSerial: cursor.frameSerial,
        };
        this.#reserved.set(key, {
          id: refreshed.id,
          sessionId: refreshed.sessionId,
          ownerPid: refreshed.ownerPid,
          ownerStart: refreshed.ownerStart,
          expiresAt: refreshed.leaseExpiresAt,
          transcriptOffset: refreshed.transcriptOffset,
          transcriptDigest: refreshed.transcriptDigest,
          transcriptGeneration: refreshed.transcriptGeneration,
          transcriptFrameSerial: refreshed.transcriptFrameSerial,
          contentDigest: refreshed.contentDigest,
        });
        return refreshed;
      });
    } catch {
      return null;
    }
  }
  /** Commit only after the caller has observed successful terminal delivery. */
  commitReservation(reservation: AnswerReservation): AnswerResult {
    return this.#withAnswerLock(null, (_candidate, all) => {
      const key = AskStateTracker.#key(reservation.block);
      const latest = all.at(-1);
      if (latest === undefined || AskStateTracker.#key(latest) !== key
        || AskStateTracker.#contentDigest(latest) !== reservation.contentDigest
        || !this.#reservationOwns(key, reservation)) {
        return this.#answered.has(key) ? { ok: false, reason: 'already-answered' } : { ok: false, reason: 'transcript-advanced' };
      }
      const deliveryState = this.#deliverySequenceState(reservation.id);
      if (deliveryState !== 'delivered') {
        return {
          ok: false,
          reason: deliveryState === 'partial' ? 'delivery-ambiguous' : 'delivery-not-observed',
        };
      }
      const deliverySteps = this.#deliverySequences.get(reservation.id);
      const finalDeliveredAt = deliverySteps === undefined ? null : this.#finalDeliveryTimestamp(deliverySteps);
      if (finalDeliveredAt === null || !this.#log.hasTerminalAfter({
        offset: reservation.transcriptOffset,
        digest: reservation.transcriptDigest,
        generation: reservation.transcriptGeneration,
        frameSerial: reservation.transcriptFrameSerial,
      }, finalDeliveredAt)) {
        return { ok: false, reason: 'delivery-not-observed' };
      }
      const rec: AskStateRecord = {
        ts: new Date().toISOString(),
        answer: reservation.answer,
        block_title: reservation.block.title,
        block_index: reservation.block.index,
        block_surface: reservation.block.surface,
        transcript_frame_start: reservation.block.frameStart,
        content_digest: reservation.contentDigest,
        status: 'committed',
        reservation_id: reservation.id,
        session_id: reservation.sessionId ?? undefined,
        owner_pid: reservation.ownerPid,
        owner_start: reservation.ownerStart,
        lease_expires_at: reservation.leaseExpiresAt,
        transcript_offset: reservation.transcriptOffset,
        transcript_digest: reservation.transcriptDigest,
        transcript_generation: reservation.transcriptGeneration,
        transcript_frame_serial: reservation.transcriptFrameSerial,
      };
      const root = this.#askStateRoot;
      if (root === null || !this.#answersReadable
        || !appendPinnedFile(root, this.#askStateName, Buffer.from(JSON.stringify(rec) + '\n', 'utf8'))) {
        return { ok: false, reason: 'persistence-error' };
      }
      this.#reserved.delete(key);
      this.#answered.add(key);
      this.#pending = null;
      return { ok: true, block: reservation.block };
    });
  }

  /** Cancel a failed delivery so a later caller may retry the same Ask. */
  cancelReservation(reservation: AnswerReservation): boolean {
    const root = this.#askStateRoot;
    if (root === null) return false;
    try {
      return withPinnedExclusiveLock(root, '.ask-state.lock', () => {
        if (!this.#reloadAnswers()) return false;
        const key = AskStateTracker.#key(reservation.block);
        if (!this.#reservationOwns(key, reservation)) return true;
        const rec: AskStateRecord = {
          ts: new Date().toISOString(),
          answer: reservation.answer,
          block_title: reservation.block.title,
          block_index: reservation.block.index,
          block_surface: reservation.block.surface,
          transcript_frame_start: reservation.block.frameStart,
          content_digest: reservation.contentDigest,
          status: 'cancelled',
          reservation_id: reservation.id,
          lease_expires_at: reservation.leaseExpiresAt,
          transcript_offset: reservation.transcriptOffset,
          transcript_digest: reservation.transcriptDigest,
          transcript_generation: reservation.transcriptGeneration,
          transcript_frame_serial: reservation.transcriptFrameSerial,
          session_id: reservation.sessionId ?? undefined,
          owner_pid: reservation.ownerPid,
          owner_start: reservation.ownerStart,
        };
        if (!appendPinnedFile(root, this.#askStateName, Buffer.from(JSON.stringify(rec) + '\n', 'utf8'))) return false;
        this.#reserved.delete(key);
        return true;
      });
    } catch {
      return false;
    }
  }

  /**
   * answer is appended to ask-state.jsonl with the stable surface/frame
   * identity, payload digest, and committed status.
   */
  answer(text: string): AnswerResult {
    const captured = this.#pending;
    return this.#withAnswerLock(captured, (candidate, all) => {
      let block = candidate;
      if (block === null) {
        block = this.#latestPending(all);
        this.#pending = block;
        if (block === null) return { ok: false, reason: all.length > 0 ? 'already-answered' : 'no-pending' };
      }
      if (!this.#blockOpen(block, all)) {
        return this.#answered.has(AskStateTracker.#key(block))
          ? { ok: false, reason: 'already-answered' }
          : { ok: false, reason: 'transcript-advanced' };
      }
      if (block.surface === 'native' && block.questions.length > 1) {
        return { ok: false, reason: 'native-multi-question-requires-explicit-answers' };
      }
      return this.#recordAnswer(block, text);
    });
  }

  /** Record explicit answers for every question in a native Ask card. */
  answerQuestions(answers: NativeAnswerMap): AnswerResult {
    const captured = this.#pending;
    return this.#withAnswerLock(captured, (candidate, all) => {
      let block = candidate;
      if (block === null) {
        block = this.#latestPending(all);
        this.#pending = block;
        if (block === null) return { ok: false, reason: all.length > 0 ? 'already-answered' : 'no-pending' };
      }
      if (!this.#blockOpen(block, all)) {
        return this.#answered.has(AskStateTracker.#key(block))
          ? { ok: false, reason: 'already-answered' }
          : { ok: false, reason: 'transcript-advanced' };
      }
      if (block.surface !== 'native') return { ok: false, reason: 'native-answer-requires-native-ask' };
      const expected = new Set(block.questions.map(question => question.id));
      for (const question of block.questions) {
        if (!Object.prototype.hasOwnProperty.call(answers, question.id)) {
          return { ok: false, reason: 'native-answer-missing-question' };
        }
        const value = answers[question.id];
        if (value === undefined || nativeOptionIndex(question, value) < 0) {
          return { ok: false, reason: 'native-answer-invalid-option' };
        }
      }
      for (const id of Object.keys(answers)) {
        if (!expected.has(id)) return { ok: false, reason: 'native-answer-unexpected-question' };
      }
      return this.#recordAnswer(block, JSON.stringify(answers));
    });
  }

  #recordAnswer(block: AskBlock, text: string): AnswerResult {
    const rec: AskStateRecord = {
      ts: new Date().toISOString(),
      answer: text,
      block_title: block.title,
      block_index: block.index,
      block_surface: block.surface,
      transcript_frame_start: block.frameStart,
      content_digest: AskStateTracker.#contentDigest(block),
      status: 'committed',
      session_id: this.#sessionId ?? undefined,
    };
    const root = this.#askStateRoot;
    if (
      root === null
      || !this.#answersReadable
      || !appendPinnedFile(root, this.#askStateName, Buffer.from(JSON.stringify(rec) + '\n', 'utf8'))
    ) {
      return { ok: false, reason: 'persistence-error' };
    }
    this.#answered.add(AskStateTracker.#key(block));
    this.#pending = null;
    return { ok: true, block };
  }
}


function nativeOptionIndex(question: AskQuestion, answer: string): number {
  const value = answer.trim();
  if (/^\d+$/u.test(value)) {
    const index = Number(value) - 1;
    return Number.isSafeInteger(index) && index >= 0 && index < question.options.length ? index : -1;
  }
  const folded = value.toLocaleLowerCase();
  return question.options.findIndex(option => option.label.toLocaleLowerCase() === folded);
}

/**
 * Drive OMP 18's native Ask card: choose each question's option and submit.
 * A multi-question card must be answered with an explicit id-to-answer map;
 * silently applying one answer to all tabs is unsafe.
 */
export async function answerNativeAsk(
  driver: Pick<TerminalDriver, 'pressEnter' | 'pressKey' | 'beginInputSequence' | 'endInputSequence'>,
  block: AskBlock,
  answers?: NativeAnswerMap | string,
): Promise<void> {
  if (block.surface !== 'native') {
    throw new Error('ux-e2e: answerNativeAsk requires a native Ask card');
  }
  if (block.questions.length === 0) {
    throw new Error('ux-e2e: native Ask card has no structured questions');
  }
  if (driver.pressKey === undefined) {
    throw new Error('ux-e2e: native Ask answers require terminal key support');
  }
  const selected: string[] = [];
  if (typeof answers === 'string') {
    if (block.questions.length > 1) {
      throw new Error('ux-e2e: native Ask has multiple questions; provide explicit answers keyed by question id');
    }
    selected.push(answers);
  } else if (answers === undefined) {
    if (block.questions.length > 1) {
      throw new Error('ux-e2e: native Ask has multiple questions; provide explicit answers keyed by question id');
    }
    selected.push('1');
  } else {
    for (const question of block.questions) {
      const answer = answers[question.id];
      if (answer === undefined) {
        throw new Error('ux-e2e: missing native Ask answer for ' + question.id);
      }
      selected.push(answer);
    }
    for (const id of Object.keys(answers)) {
      if (!block.questions.some(question => question.id === id)) {
        throw new Error('ux-e2e: unexpected native Ask answer key ' + id);
      }
    }
  }

  const optionIndices: number[] = [];
  for (let index = 0; index < block.questions.length; index += 1) {
    const question = block.questions[index];
    if (question === undefined) continue;
    const optionIndex = nativeOptionIndex(question, selected[index] ?? '');
    if (optionIndex < 0) {
      throw new Error('ux-e2e: invalid native Ask answer for ' + question.id + ': ' + (selected[index] ?? ''));
    }
    optionIndices.push(optionIndex);
  }
  const totalSteps = optionIndices.reduce((total, optionIndex) => total + optionIndex, 0)
    + block.questions.length
    + Math.max(0, block.questions.length - 1)
    + 2;
  driver.beginInputSequence?.(totalSteps);
  try {
    for (let index = 0; index < block.questions.length; index += 1) {
      const optionIndex = optionIndices[index] ?? 0;
      for (let move = 0; move < optionIndex; move += 1) await driver.pressKey('ArrowDown');
      await driver.pressEnter(false);
      if (index < block.questions.length - 1) await driver.pressKey('ArrowRight');
    }
    await driver.pressKey('ArrowRight');
    await driver.pressEnter(true);
  } finally {
    driver.endInputSequence?.();
  }
}


/**
 * Answer a host selector while attaching a trusted n-note to the selected option.
 * OMP's AskDialog submits this note as the result item's `note` field; unlike
 * the legacy ui.select path, this records no Other/customInput fallback.
 */
export async function answerSelectedAskWithNote(
  driver: Pick<TerminalDriver, 'type' | 'pressEnter' | 'pressKey' | 'beginInputSequence' | 'endInputSequence'>,
  block: SelectedAskBlock,
  desired: string,
  note: string,
): Promise<void> {
  if (block.surface !== 'selector') {
    throw new Error('ux-e2e: answerSelectedAskWithNote requires a host selector card');
  }
  if (driver.pressKey === undefined) {
    throw new Error('ux-e2e: selected Ask answers require terminal key support');
  }
  const folded = desired.trim().toLocaleLowerCase();
  const targetIndex = block.options.findIndex(option => option.trim().toLocaleLowerCase() === folded);
  if (targetIndex < 0) {
    throw new Error(`ux-e2e: selected Ask option is not present: ${desired}`);
  }
  const currentIndex = block.selectedIndex >= 0 && block.selectedIndex < block.options.length
    ? block.selectedIndex
    : 0;
  const movement = Math.abs(targetIndex - currentIndex);
  driver.beginInputSequence?.(movement + 4);
  try {
    const key: TerminalKey = targetIndex >= currentIndex ? 'ArrowDown' : 'ArrowUp';
    for (let move = movement; move > 0; move -= 1) await driver.pressKey(key);
    // AskDialog's authoritative n-note flow keeps the selected option and
    // returns the submitted text as result.note; Other/customInput is never
    // used for policy feedback.
    await driver.type('n');
    await driver.type(note);
    await driver.pressEnter(false);
    await driver.pressEnter(true);
  } finally {
    driver.endInputSequence?.();
  }
}

/**
 * Answer a host `ui.select` checkpoint with real terminal navigation events.
 *
 * The selector does not accept typed labels: it consumes ArrowUp/ArrowDown and
 * Enter from the focused PTY component. Keeping this path explicit prevents a
 * test from accidentally recording an answer in the legacy ask-state file.
 */
export async function answerSelectedAsk(
  driver: Pick<TerminalDriver, 'pressEnter' | 'pressKey' | 'beginInputSequence' | 'endInputSequence'>,
  block: SelectedAskBlock,
  desired: string,
): Promise<void> {
  if (block.surface !== 'selector') {
    throw new Error('ux-e2e: answerSelectedAsk requires a host selector card');
  }
  if (driver.pressKey === undefined) {
    throw new Error('ux-e2e: selected Ask answers require terminal key support');
  }
  const folded = desired.trim().toLocaleLowerCase();
  const targetIndex = block.options.findIndex(option => option.trim().toLocaleLowerCase() === folded);
  if (targetIndex < 0) {
    throw new Error(`ux-e2e: selected Ask option is not present: ${desired}`);
  }
  const currentIndex = block.selectedIndex >= 0 && block.selectedIndex < block.options.length
    ? block.selectedIndex
    : 0;
  const movement = Math.abs(targetIndex - currentIndex);
  const key: TerminalKey = targetIndex >= currentIndex ? 'ArrowDown' : 'ArrowUp';
  driver.beginInputSequence?.(movement + 1);
  try {
    for (let move = movement; move > 0; move -= 1) {
      await driver.pressKey(key);
    }
    await driver.pressEnter();
  } finally {
    driver.endInputSequence?.();
  }
}
