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
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  openSync,
  readFileSync,
  readSync,
} from 'node:fs';
import { resolve } from 'node:path';

import type { Browser, Page } from 'playwright';
import { WebSocket } from 'ws';

import type { TranscriptFrame } from './server.js';

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
    const { promise: ticked, resolve: tick } = Promise.withResolvers<void>();
    setTimeout(tick, intervalMs);
    await ticked;
  }
}

/** Strip ANSI escape sequences (SGR, cursor movement, etc.). */
export function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '');
}

/* ------------------------------------------------------------------ */
/* TerminalDriver interface                                            */
/* ------------------------------------------------------------------ */

export interface TerminalDriver {
  /** Connect to the session surface (opens the WS / launches the browser). */
  open(url: string): Promise<void>;
  /** Return the current terminal screen as text. */
  readScreen(): Promise<string>;
  /** Save a screenshot; returns the written path. Throws in text mode. */
  screenshot(path: string): Promise<string>;
  /** Send raw text to the terminal (no trailing newline added). */
  type(text: string): Promise<void>;
  /** Close the connection / browser. */
  close(): Promise<void>;
}

/* ------------------------------------------------------------------ */
/* WsDriver — text mode over the transcript                            */
/* ------------------------------------------------------------------ */

export interface WsDriverOptions {
  /** WS page URL from session.json (`http://host:port/?token=...`). */
  readonly url: string;
  /** Path of the server-side transcript.jsonl used by readScreen(). */
  readonly transcriptPath: string;
}

/**
 * Pure-WS terminal driver. `readScreen()` tails the server-side
 * transcript (the same evidence file the report uses), so the text
 * surface never needs a browser.
 */
export class WsDriver implements TerminalDriver {
  readonly #wsUrl: string;
  readonly #transcriptPath: string;
  #ws: WebSocket | null = null;

  constructor(opts: WsDriverOptions) {
    this.#wsUrl = wsUrlFromPageUrl(opts.url);
    this.#transcriptPath = resolve(opts.transcriptPath);
  }

  async open(): Promise<void> {
    if (this.#ws !== null) return;
    const ws = new WebSocket(this.#wsUrl);

    const { promise: opened, resolve: openSucceeded, reject: openFailed } = Promise.withResolvers<void>();
    ws.once('open', () => openSucceeded());
    ws.once('error', err => openFailed(err));

    // Auth ack: the server sends {t:'s', ok:true} right after upgrade.
    const { promise: acked, resolve: ackReceived, reject: ackFailed } = Promise.withResolvers<void>();
    ws.once('message', raw => {
      try {
        const msg = JSON.parse(raw.toString('utf8')) as { t?: string; ok?: boolean };
        if (msg.t === 's' && msg.ok === true) ackReceived();
        else ackFailed(new Error(`ux-e2e: unexpected first frame ${raw.toString('utf8')}`));
      } catch (err) {
        ackFailed(err instanceof Error ? err : new Error(String(err)));
      }
    });

    await opened;
    const { promise: timedOut, reject: timeoutReached } = Promise.withResolvers<never>();
    const timer = setTimeout(() => timeoutReached(new WaitTimeoutError('ux-e2e: ws auth ack timeout')), 5000);
    try {
      await Promise.race([acked, timedOut]);
    } finally {
      clearTimeout(timer);
    }
    this.#ws = ws;
  }

  async readScreen(): Promise<string> {
    if (!existsSync(this.#transcriptPath)) return '';
    const text = readFileSync(this.#transcriptPath, 'utf8');
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

  async type(text: string): Promise<void> {
    if (this.#ws === null || this.#ws.readyState !== WebSocket.OPEN) {
      throw new Error('ux-e2e: ws not open — call open() first');
    }
    this.#ws.send(JSON.stringify({ t: 'i', d: text }));
  }

  async close(): Promise<void> {
    const ws = this.#ws;
    this.#ws = null;
    if (ws !== null) {
      try {
        ws.close();
      } catch {
        /* ignore. */
      }
    }
  }
}

/** Build the `ws://host:port/ws?token=...` URL from the page URL. */
export function wsUrlFromPageUrl(pageUrl: string): string {
  const u = new URL(pageUrl);
  const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
  const token = u.searchParams.get('token') ?? '';
  return `${proto}//${u.host}/ws?token=${encodeURIComponent(token)}`;
}

/* ------------------------------------------------------------------ */
/* PlaywrightDriver — real chromium, lazy dependency                   */
/* ------------------------------------------------------------------ */

/** Minimal structural view of the xterm instance exposed by page.js. */
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
    const browser = await this.#pw.chromium.launch({ headless: this.#headless });
    const page = await browser.newPage();
    await page.goto(url, { waitUntil: 'load' });
    await page.waitForFunction(
      () => (globalThis as unknown as PageGlobal).__uxTerm !== undefined,
      { timeout: 10_000 },
    );
    this.#browser = browser;
    this.#page = page;
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

export interface AskBlock {
  /** 1-based index of the ask in the transcript (stable key). */
  readonly index: number;
  /** The line containing `[ask_user]`, ANSI-stripped and trimmed. */
  readonly title: string;
  /** Numbered option lines that follow the title. */
  readonly options: string[];
  /** Frame index of the first frame containing the block. */
  readonly frameStart: number;
  /** Frame index AFTER the last frame belonging to the block. */
  readonly frameEnd: number;
}

const OPTION_LINE_RE = /^\s*(?:\d+[.)\]]\s*|\*\s*|-\s*|\[[ xX]\]\s*)/u;

/**
 * Append-only scanner over transcript.jsonl. `refresh()` re-reads only
 * the lines appended since the last scan (O(delta)), keeping repeated
 * polls cheap while the session runs.
 */
export class TranscriptLog {
  readonly #path: string;
  readonly #frames: TranscriptFrame[] = [];
  #cursorLines = 0;

  constructor(transcriptPath: string) {
    this.#path = resolve(transcriptPath);
  }

  /** Ingest newly appended frames; returns the new frames. */
  refresh(): TranscriptFrame[] {
    if (!existsSync(this.#path)) return [];
    const fd = openSync(this.#path, 'r');
    try {
      const { size } = fstatSync(fd);
      const buf = Buffer.alloc(size);
      let offset = 0;
      while (offset < buf.length) {
        const n = readSync(fd, buf, offset, buf.length - offset, offset);
        if (n <= 0) break;
        offset += n;
      }
      const text = buf.toString('utf8');
      const lines = text.split('\n');
      const added: TranscriptFrame[] = [];
      for (let i = this.#cursorLines; i < lines.length; i += 1) {
        const line = lines[i]?.trim();
        if (line === undefined || line.length === 0) continue;
        try {
          const frame = JSON.parse(line) as TranscriptFrame;
          this.#frames.push(frame);
          added.push(frame);
        } catch {
          /* skip partial line */
        }
      }
      this.#cursorLines = lines.length;
      return added;
    } finally {
      try {
        closeSync(fd);
      } catch {
        /* ignore. */
      }
    }
  }

  /** All frames ingested so far (call refresh() first for new data). */
  get frames(): readonly TranscriptFrame[] {
    return this.#frames;
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

  #scanBlocks(): AskBlock[] {
    const blocks: AskBlock[] = [];
    let index = 0;
    let inBlock = false;
    let title = '';
    let options: string[] = [];
    let frameStart = 0;

    const flush = (frameEnd: number): void => {
      if (!inBlock) return;
      blocks.push({ index, title, options, frameStart, frameEnd });
      inBlock = false;
    };

    for (let fi = 0; fi < this.#frames.length; fi += 1) {
      const frame = this.#frames[fi];
      if (frame === undefined) continue;
      if (frame.t !== 'o' || typeof frame.d !== 'string') {
        // A non-output frame (exit/err) always terminates a block.
        flush(fi);
        continue;
      }
      const linesRaw = stripAnsi(frame.d).split('\n');
      // The final split element after a trailing newline is not a real
      // line — a "blank line" that ends a frame must not close the block.
      const lines = linesRaw[linesRaw.length - 1] === '' ? linesRaw.slice(0, -1) : linesRaw;
      for (const rawLine of lines) {
        const line = rawLine.trim();
        if (line.length === 0) {
          // Blank line terminates the option list of an open block.
          if (inBlock) flush(fi);
          continue;
        }
        if (line.includes('[ask_user]')) {
          flush(fi);
          index += 1;
          inBlock = true;
          title = line;
          options = [];
          frameStart = fi;
          continue;
        }
        if (inBlock) {
          if (OPTION_LINE_RE.test(line)) {
            options.push(line);
            continue;
          }
          // Non-option, non-blank line ends the block.
          flush(fi);
        }
      }
    }
    flush(this.#frames.length);
    return blocks;
  }
}

/* ------------------------------------------------------------------ */
/* AskStateTracker — unanswered [ask_user] blocks + double-answer guard */
/* ------------------------------------------------------------------ */

export interface AskStateRecord {
  readonly ts: string;
  readonly answer: string;
  readonly block_title: string;
  readonly block_index: number;
}

export type AnswerResult =
  | { readonly ok: true; readonly block: AskBlock }
  | { readonly ok: false; readonly reason: 'no-pending' | 'already-answered' | 'transcript-advanced' };

/**
 * Tracks unanswered [ask_user] blocks across the transcript and the
 * ask-state.jsonl answer log.
 *
 * Double-answer guard: `answer()` refuses when the block it captured is
 * already recorded in ask-state (already-answered) or when the transcript
 * has advanced past it (transcript-advanced) — e.g. the agent already
 * typed an answer and omp moved on to a new stage/ask.
 */
export class AskStateTracker {
  readonly #log: TranscriptLog;
  readonly #askStatePath: string;
  readonly #answered: Set<string> = new Set();
  #pending: AskBlock | null = null;

  constructor(transcriptPath: string, askStatePath: string) {
    this.#log = new TranscriptLog(transcriptPath);
    this.#askStatePath = resolve(askStatePath);
    this.#reloadAnswers();
  }

  static #key(block: AskBlock): string {
    return `${block.index}:${block.title}`;
  }

  #reloadAnswers(): void {
    this.#answered.clear();
    if (!existsSync(this.#askStatePath)) return;
    for (const line of readFileSync(this.#askStatePath, 'utf8').split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const rec = JSON.parse(line) as Partial<AskStateRecord>;
        if (typeof rec.block_index === 'number' && typeof rec.block_title === 'string') {
          this.#answered.add(`${rec.block_index}:${rec.block_title}`);
        }
      } catch {
        /* skip corrupt lines */
      }
    }
  }

  /** True when the block is still actionable: latest ask and unanswered. */
  #blockOpen(block: AskBlock, all: readonly AskBlock[]): boolean {
    if (this.#answered.has(AskStateTracker.#key(block))) return false;
    const last = all[all.length - 1];
    return last !== undefined && last.index === block.index;
  }

  /**
   * Recompute and return the current pending [ask_user] block — the
   * latest unanswered ask — or null.
   */
  pendingBlock(): AskBlock | null {
    this.#log.refresh();
    this.#reloadAnswers();
    const all = this.#log.askBlocks();
    const open = all.filter(b => this.#blockOpen(b, all));
    this.#pending = open[open.length - 1] ?? null;
    return this.#pending;
  }

  /** The block captured by the most recent pendingBlock() call. */
  get pending(): AskBlock | null {
    return this.#pending;
  }

  /**
   * Record an answer for the pending block (guarded). On success the
   * answer is appended to ask-state.jsonl as `{ts, answer, block_title,
   * block_index}`.
   */
  answer(text: string): AnswerResult {
    const captured = this.#pending;
    this.#log.refresh();
    this.#reloadAnswers();
    const all = this.#log.askBlocks();

    if (captured === null) {
      // Nothing captured yet — refresh and decide from the live state.
      const fresh = this.pendingBlock();
      if (fresh !== null) return this.#recordAnswer(fresh, text);
      const all = this.#log.askBlocks();
      if (all.length > 0) {
        const last = all[all.length - 1];
        if (last !== undefined && this.#answered.has(AskStateTracker.#key(last))) {
          return { ok: false, reason: 'already-answered' };
        }
        return { ok: false, reason: 'transcript-advanced' };
      }
      return { ok: false, reason: 'no-pending' };
    }
    if (this.#answered.has(AskStateTracker.#key(captured))) {
      return { ok: false, reason: 'already-answered' };
    }
    if (!this.#blockOpen(captured, all)) {
      return { ok: false, reason: 'transcript-advanced' };
    }
    return this.#recordAnswer(captured, text);
  }

  #recordAnswer(block: AskBlock, text: string): AnswerResult {
    const rec: AskStateRecord = {
      ts: new Date().toISOString(),
      answer: text,
      block_title: block.title,
      block_index: block.index,
    };
    try {
      appendFileSync(this.#askStatePath, JSON.stringify(rec) + '\n');
    } catch {
      return { ok: false, reason: 'no-pending' };
    }
    this.#answered.add(AskStateTracker.#key(block));
    this.#pending = null;
    return { ok: true, block };
  }
}
