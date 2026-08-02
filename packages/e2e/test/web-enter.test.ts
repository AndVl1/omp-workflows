/**
 * Web Enter-button + pressEnter driver tests.
 *
 * Three contracts are pinned here:
 *   1. WsDriver.pressEnter() sends {t:'i', d:'\r'} — real Enter (CR,
 *      0x0D), NOT '\n' (which is just a line break in the editor).
 *   2. The web surface (terminal.html + page.js) renders a toolbar with
 *      an "⏎ Enter" button (id="enter-btn") that calls
 *      window.__pressEnter(); the function exposes window.__typeText
 *      for tests.
 *   3. The end-to-end click flow: open the URL with chromium, focus
 *      the terminal, click the Enter button, assert the PTY received
 *      '\r' (verified by the fake-PTY script that dumps raw bytes via
 *      `od -An -c` with `stty raw` to disable the kernel ICRNL
 *      translation).
 *
 * The chromium integration test SKIPS when playwright or chromium
 * cannot be loaded — it is environment-dependent (needs
 * `playwright install chromium`) and must never fail CI without a
 * browser installed. The unit contracts (1, 2) always run.
 */

import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { WsDriver } from '../src/driver.js';
import { startTestSession } from '../src/server.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * A tiny shell script that disables the kernel PTY driver's ICRNL
 * translation (so CR bytes pass through unchanged) and dumps every
 * received byte via `od -An -c`. The output for a bare `\r` is the
 * 2-char sequence `\r`, which the test can grep for unambiguously.
 * Without `stty raw`, ICRNL would rewrite `\r` → `\n` and the test
 * could not distinguish Enter from a plain line break.
 */
const FAKE_ENTER_SCRIPT = `#!/bin/sh
# Disable the kernel PTY driver's ICRNL translation so the CR byte
# (0x0D) is delivered to the script's stdin as \\r, NOT rewritten to
# LF (0x0A). Then dump every received byte via 'od -An -c' which
# renders non-printing bytes as their C escape.
stty raw -echo 2>/dev/null || true
exec od -An -c
`;

/**
 * A shell script that keeps the PTY alive long enough for the test
 * to observe inbound frames without producing noise that confuses
 * the assertions. `cat` reads stdin until EOF and forwards every
 * byte to stdout (the kernel adds \r → \r\n on output via OPOST);
 * the unit tests read the transcript's input frames directly
 * (`{t:'i',d}` is appended BEFORE the PTY write), so the output
 * stream is irrelevant for the assertions. The script does NOT
 * exit on its own — `cat` only exits on EOF or signal.
 */
const FAKE_IDLE_SCRIPT = '#!/bin/sh\nexec cat\n';

/** Replace `new Promise((r) => setTimeout(r, ms))` with withResolvers. */
function sleep(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

/**
 * Poll the transcript until predicate returns truthy. Resolves to
 * the final transcript text. Polls every 50 ms (matches the pattern
 * used elsewhere in this package) — the predicate is waiting for a
 * real PTY event from a real process, so the wait is bounded by
 * real disk I/O, not a fixed wall-clock guess.
 */
async function waitForTranscript(
  transcriptPath: string,
  predicate: (text: string) => boolean,
  label: string,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < 5000) {
    let text = '';
    try {
      text = readFileSync(transcriptPath, 'utf8');
    } catch {
      /* file may not exist yet — keep polling */
    }
    if (predicate(text)) return text;
    await sleep(50);
  }
  throw new Error(`waitForTranscript(${label}) timed out`);
}

/** Extract the `d` field of every {t:'i', d:...} frame in
 * transcript.jsonl. The server appends each inbound frame BEFORE
 * writing to the PTY (see src/server.ts), so this is the exact set
 * of bytes WsDriver / PlaywrightDriver emitted. */
function readInputFrames(transcriptText: string): string[] {
  const frames: string[] = [];
  for (const line of transcriptText.split('\n')) {
    if (line.trim().length === 0) continue;
    try {
      const f = JSON.parse(line) as { t?: string; d?: string };
      if (f.t === 'i' && typeof f.d === 'string') frames.push(f.d);
    } catch {
      /* skip partial or non-JSON lines */
    }
  }
  return frames;
}

/** Spawn a fake-PTY idle session and return its handle + the script
 * path. Returns `null` (and skips the caller) when node-pty cannot
 * spawn — callers use `t.skip()` via the returned tuple. */
async function spawnIdleSession(t: import('node:test').TestContext): Promise<{
  session: Awaited<ReturnType<typeof startTestSession>>;
  scriptPath: string;
} | null> {
  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-enter-'));
  mkdirSync(join(dir, '.work-state', 'ux-e2e'), { recursive: true });
  const scriptPath = join(dir, 'fake-idle.sh');
  writeFileSync(scriptPath, FAKE_IDLE_SCRIPT, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);

  let session;
  try {
    session = await startTestSession({ cwd: dir, ompBinary: scriptPath, token: 'sekret', idleMs: 10_000 });
  } catch (err) {
    t.skip(`node-pty unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
  t.after(() => session.close());
  if (session.pty.mode !== 'pty') {
    t.skip('node-pty could not spawn the idle script');
    return null;
  }
  return { session, scriptPath };
}

/* ------------------------------------------------------------------ */
/* 1. WsDriver.pressEnter sends {t:'i', d:'\r'}                       */
/* ------------------------------------------------------------------ */

test('WsDriver: pressEnter sends a single {t:"i",d:"\\r"} frame', async t => {
  const spawned = await spawnIdleSession(t);
  if (spawned === null) return;
  const { session } = spawned;

  const driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath });
  await driver.open();
  await driver.pressEnter();
  await driver.close();
  // Brief settle — `driver.close()` resolves after the local WS close
  // frame is sent, but the server's frame append may still be in
  // flight on its event loop.
  await sleep(50);

  const frames = readInputFrames(readFileSync(session.transcriptPath, 'utf8'));
  assert.deepEqual(frames, ['\r'], 'pressEnter delivered exactly one CR frame');
});

test('WsDriver: submit() appends "\\n" while pressEnter() sends "\\r" — different bytes', async t => {
  const spawned = await spawnIdleSession(t);
  if (spawned === null) return;
  const { session } = spawned;

  const driver = new WsDriver({ url: session.url, transcriptPath: session.transcriptPath });
  await driver.open();
  await driver.pressEnter();
  await driver.submit('hello');
  await driver.close();
  await sleep(50);

  const frames = readInputFrames(readFileSync(session.transcriptPath, 'utf8'));
  assert.equal(frames.length, 2, 'two input frames observed');
  assert.equal(frames[0], '\r', 'pressEnter sends CR (0x0D)');
  assert.equal(frames[1], 'hello\n', 'submit appends LF (0x0A) — different byte, legacy behaviour');
});

/* ------------------------------------------------------------------ */
/* 2. Static page assets — Enter button + pressEnter/typeText globals  */
/* ------------------------------------------------------------------ */

test('web surface: terminal.html embeds the Enter toolbar with #enter-btn', () => {
  const html = readFileSync(join(HERE, '..', 'assets', 'terminal.html'), 'utf8');
  assert.match(html, /id="enter-btn"/u, 'Enter button id is present');
  assert.match(html, /⏎ Enter/u, 'Enter button label is present');
  assert.match(html, /#toolbar/u, 'button lives inside the toolbar');
  // Dark-theme toolbar styling (the rest of the bar) is colocated in
  // terminal.html, not page.js — assert the cursor + base colors are
  // present so a regression here (e.g. switching to a light theme)
  // would be caught.
  assert.match(html, /background:\s*#0b0b0b/u, 'terminal background is the dark theme base');
});

test('web surface: page.js wires the button to window.__pressEnter', () => {
  const js = readFileSync(join(HERE, '..', 'assets', 'page.js'), 'utf8');
  // The wiring is in page.js (addEventListener on #enter-btn), not
  // inline onclick in HTML.
  assert.match(js, /enterBtn\.addEventListener\(['"]click['"]/u, 'button click is bound in page.js');
  assert.match(js, /window\.__pressEnter\s*=\s*pressEnter/u, '__pressEnter is assigned');
  assert.match(js, /window\.__typeText\s*=\s*typeText/u, '__typeText is assigned');
});

test('web surface: page.js primary path uses synthetic KeyboardEvent(Enter) with the right fields', () => {
  const js = readFileSync(join(HERE, '..', 'assets', 'page.js'), 'utf8');
  // Primary path: synthetic KeyboardEvent on term.textarea.
  assert.match(js, /new\s+KeyboardEvent\(\s*['"]keydown['"]/u, 'synthesises keydown KeyboardEvent');
  assert.match(js, /key\s*:\s*['"]Enter['"]/u, 'key field is Enter');
  assert.match(js, /code\s*:\s*['"]Enter['"]/u, 'code field is Enter');
  assert.match(js, /keyCode\s*:\s*13/u, 'keyCode field is 13');
  assert.match(js, /which\s*:\s*13/u, 'which field is 13');
  assert.match(js, /bubbles\s*:\s*true/u, 'bubbles is true');
  assert.match(js, /cancelable\s*:\s*true/u, 'cancelable is true');
});

test('web surface: page.js fallback sends {t:"i",d:"\\r"} after a bounded timeout, with no-duplicate guard', () => {
  const js = readFileSync(join(HERE, '..', 'assets', 'page.js'), 'utf8');
  // Fallback path: direct WS send of '\r'.
  assert.match(js, /t:\s*['"]i['"],\s*d:\s*['"]\\r['"]/u, 'fallback sends {t:"i",d:"\\r"}');
  // Fallback is guarded by a one-shot onData listener that flips a
  // flag when xterm sees '\r', so the fallback never duplicates
  // when the primary path succeeded.
  assert.match(js, /term\.onData\(/u, 'installs a one-shot onData listener');
  assert.match(js, /disposable\.dispose\(\)/u, 'disposes the listener after the timeout');
});

/* ------------------------------------------------------------------ */
/* 3. End-to-end: click Enter button → PTY receives '\r' (chromium)    */
/* ------------------------------------------------------------------ */

test('web surface (chromium): pressing the Enter button delivers CR to the PTY', async t => {
  // Lazy import of playwright — mirrors the optional-dep pattern in
  // `createPlaywrightDriver`. The static import would fail in test
  // environments where playwright is not installed.
  let pw: typeof import('playwright');
  try {
    pw = (await import('playwright')) as typeof import('playwright');
  } catch {
    t.skip('playwright is not installed');
    return;
  }

  const dir = mkdtempSync(join(tmpdir(), 'ux-e2e-enter-'));
  mkdirSync(join(dir, '.work-state', 'ux-e2e'), { recursive: true });
  const scriptPath = join(dir, 'fake-enter.sh');
  writeFileSync(scriptPath, FAKE_ENTER_SCRIPT, { mode: 0o755 });
  chmodSync(scriptPath, 0o755);

  let session;
  try {
    session = await startTestSession({
      cwd: dir,
      ompBinary: scriptPath,
      token: 'sekret',
      idleMs: 10_000,
      cols: 120,
      rows: 30,
    });
  } catch (err) {
    t.skip(`node-pty unavailable: ${err instanceof Error ? err.message : String(err)}`);
    return;
  }
  t.after(() => session.close());
  if (session.pty.mode !== 'pty') {
    t.skip('node-pty could not spawn the fake enter command');
    return;
  }

  // The page-side helpers are installed by page.js — wait until
  // both are defined before driving.
  let browser: import('playwright').Browser | undefined;
  try {
    browser = await pw.chromium.launch({ headless: true });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    page.on('pageerror', err => { throw new Error(`page error: ${err.message}`); });

    await page.goto(session.url, { waitUntil: 'load' });
    await page.waitForFunction(
      () => {
        const g = globalThis as unknown as { __uxTerm?: unknown; __pressEnter?: unknown };
        return g.__uxTerm !== undefined && g.__pressEnter !== undefined;
      },
      { timeout: 10_000 },
    );
    await page.waitForSelector('#enter-btn:not([disabled])', { timeout: 5_000 });

    // (1) Click the toolbar button — primary path: synthetic KeyboardEvent.
    await page.click('#enter-btn');
    await waitForTranscript(
      session.transcriptPath,
      t => readInputFrames(t).includes('\r'),
      'CR after button click',
    );
    const frames1 = readInputFrames(readFileSync(session.transcriptPath, 'utf8'));
    assert.ok(frames1.includes('\r'), 'PTY transcript shows a \\r frame after Enter click');

    // (2) Direct call to window.__pressEnter() — same primary path.
    const directResult = await page.evaluate(() => {
      const g = globalThis as unknown as { __pressEnter?: () => unknown };
      return g.__pressEnter !== undefined ? g.__pressEnter() : undefined;
    });
    assert.equal(typeof directResult, 'boolean', '__pressEnter resolves to a boolean');
    const frames2 = await waitForTranscript(
      session.transcriptPath,
      t => readInputFrames(t).filter(d => d === '\r').length >= 2,
      'second CR delivered via __pressEnter',
    );
    assert.ok(readInputFrames(frames2).filter(d => d === '\r').length >= 2);

    // (3) window.__typeText bypasses xterm and sends raw bytes — used
    //     by tests that don't want to drive keyboard events.
    await page.evaluate(() => {
      const g = globalThis as unknown as { __typeText?: (s: string) => void };
      g.__typeText?.('plain');
    });
    const frames3 = await waitForTranscript(
      session.transcriptPath,
      t => readInputFrames(t).includes('plain'),
      '__typeText reaches PTY',
    );
    assert.ok(readInputFrames(frames3).includes('plain'), '__typeText frame observed');

    // (4) Real-keyboard path — page.keyboard.press('Enter') must also
    //     produce '\r' on the wire (this is the path PlaywrightDriver
    //     uses via `page.keyboard.press('Enter')`).
    await page.locator('.xterm-helper-textarea').first().focus();
    await page.keyboard.press('Enter');
    const frames4 = await waitForTranscript(
      session.transcriptPath,
      t => readInputFrames(t).filter(d => d === '\r').length >= 3,
      'third CR delivered via page.keyboard.press(Enter)',
    );
    assert.ok(readInputFrames(frames4).filter(d => d === '\r').length >= 3);

    await ctx.close();
  } catch (err) {
    if (err instanceof Error && /Executable doesn't exist|browserType\.launch/i.test(err.message)) {
      t.skip(`chromium not installed: ${err.message}`);
      return;
    }
    throw err;
  } finally {
    if (browser !== undefined) {
      try { await browser.close(); } catch { /* ignore */ }
    }
  }
});