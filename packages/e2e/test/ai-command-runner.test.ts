import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import {
  AI_PUBLIC_DEFAULTS,
  discoverCommandIds,
  defaultMonorepoRoot,
  defaultManifestPath,
  loadAiCommandManifest,
  redactSensitive,
  renderCommandPrompt,
  resolveAiModelConfig,
  runAiCommandMatrix,
  validateAiCommandManifest,
  containsSensitive,
  writeModelOverlay,
  type BrowserClient,
} from '../src/ai-command-runner.js';
import type { TestSession, TestSessionOptions } from '../src/server.js';

function temporaryDirectory(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

test('AI manifest exactly covers the canonical shipped command tree', () => {
  const manifest = loadAiCommandManifest();
  const discovered = discoverCommandIds(defaultMonorepoRoot());
  validateAiCommandManifest(manifest, discovered);
  assert.deepEqual(discovered, ['cto', 'do-work', 'init-team', 'interview', 'omp-model-roles', 'session-report', 'team']);
  assert.equal(manifest.commands.length, discovered.length);
  assert.ok(manifest.promptTemplate.includes('{instruction}'));
});
test('AI manifest rejects control characters in keyboard-injected fields', () => {
  const dir = temporaryDirectory('ai-manifest-');
  const raw = JSON.parse(readFileSync(defaultManifestPath(), 'utf8')) as { commands: Array<Record<string, unknown>> };
  const first = raw.commands[0];
  assert.ok(first !== undefined);
  first.command_args = 'unsafe\ninput';
  const path = join(dir, 'manifest.json');
  writeFileSync(path, JSON.stringify({ ...raw, schema_version: 1 }));
  assert.throws(() => loadAiCommandManifest(path), /control characters/iu);
});

test('AI registry completeness rejects a missing or extra command', () => {
  const root = temporaryDirectory('ai-registry-');
  mkdirSync(join(root, 'packages', 'fullstack', 'commands', 'alpha'), { recursive: true });
  mkdirSync(join(root, 'packages', 'fullstack', 'commands', 'beta'), { recursive: true });
  const manifest = loadAiCommandManifest();
  assert.throws(() => validateAiCommandManifest(manifest, ['alpha', 'beta']), /coverage mismatch/);
  const base = manifest.commands.find(command => command.id === 'team');
  assert.ok(base !== undefined);
  const conflict = { ...manifest, commands: [...manifest.commands, { ...base, id: 'team-config', pickerPrefix: 'tea' }] };
  assert.throws(
    () => validateAiCommandManifest(conflict, [...manifest.commands.map(command => command.id), 'team-config']),
    /matches another command/iu,
  );
});

test('AI model defaults match the resolved pi-catalog contract', () => {
  assert.deepEqual(AI_PUBLIC_DEFAULTS, {
    provider: 'opencode-go',
    baseModel: 'deepseek-v4-flash',
    visualModel: 'minimax-m3',
  });
  const config = resolveAiModelConfig({});
  assert.equal(config.publicProvider, 'opencode-go');
  assert.equal(config.baseModel, 'deepseek-v4-flash');
  assert.equal(config.visualModel, 'minimax-m3');
});

test('AI model mapping is qualified, renders selectors, and never serializes the API key', () => {
  const config = resolveAiModelConfig({
    OMP_API_PROVIDER: 'opencode-go',
    OMP_BASE_MODEL: 'deepseek-v4-flash',
    OMP_VISUAL_MODEL: 'minimax-m3',
    OPENCODE_API_KEY: 'test-secret-key',
  });
  // Base roles resolve to the `:high` selector; vision resolves to the
  // bare vision-capable id (modelRoles selectors are provider/id[:thinking]).
  assert.equal(config.modelRoles.default, 'opencode-go/deepseek-v4-flash:high');
  assert.equal(config.modelRoles.task, 'opencode-go/deepseek-v4-flash:high');
  assert.equal(config.modelRoles.advisor, 'opencode-go/deepseek-v4-flash:high');
  assert.equal(config.modelRoles.vision, 'opencode-go/minimax-m3');
  assert.equal(Object.values(config.modelRoles).filter(role => role === 'opencode-go/deepseek-v4-flash:high').length, 9);
  assert.equal(JSON.stringify(config.modelRoles).includes('test-secret-key'), false);
  assert.match(renderCommandPrompt('Run /{command}: {instruction}', { ...config, id: 'demo', pickerPrefix: 'demo', commandArgs: 'x', instruction: 'check', startPatterns: ['start'], errorPatterns: ['error'] }), /Run \/demo: check/);
});

test('AI model mapping rejects provider "opencode" and names "opencode-go"', () => {
  assert.throws(
    () => resolveAiModelConfig({ OMP_API_PROVIDER: 'opencode' }),
    /unsupported OMP_API_PROVIDER "opencode".*expected provider id is "opencode-go"/u,
  );
});

test('AI model mapping rejects text-only minimax-m2.5 for vision with the catalog evidence', () => {
  assert.throws(
    () => resolveAiModelConfig({ OMP_VISUAL_MODEL: 'minimax-m2.5' }),
    /minimax-m2\.5.*cannot serve modelRoles\.vision.*\["text"\] only.*models\.json:66960-66969/u,
  );
});

test('AI model mapping rejects an unknown visual model (never silently substitutes)', () => {
  assert.throws(
    () => resolveAiModelConfig({ OMP_VISUAL_MODEL: 'some-unknown-vision-model' }),
    /unsupported OMP_VISUAL_MODEL "some-unknown-vision-model".*vision-capable opencode-go model/u,
  );
});

test('AI model mapping accepts every catalog vision-capable opencode-go id', () => {
  for (const visualModel of ['minimax-m3', 'kimi-k2.5', 'mimo-v2.5']) {
    const config = resolveAiModelConfig({ OMP_VISUAL_MODEL: visualModel });
    assert.equal(config.modelRoles.vision, `opencode-go/${visualModel}`);
  }
});

test('AI model overlay is secret-free modelRoles JSON with mode 0600', () => {
  const dir = temporaryDirectory('ai-overlay-');
  const config = resolveAiModelConfig({ OPENCODE_API_KEY: 'test-secret-key' });
  const overlayPath = join(dir, 'ux-e2e-overlay.user.json');
  writeModelOverlay(overlayPath, config);
  const raw = readFileSync(overlayPath, 'utf8');
  const overlay = JSON.parse(raw) as { modelRoles?: Record<string, string> };
  assert.equal(overlay.modelRoles?.default, 'opencode-go/deepseek-v4-flash:high');
  assert.equal(overlay.modelRoles?.vision, 'opencode-go/minimax-m3');
  assert.equal(raw.includes('test-secret-key'), false);
  assert.equal(raw.includes('apiKey'), false);
  assert.equal((0o600 & (0o777 & statSync(overlayPath).mode)), 0o600);
});

test('AI evidence redaction removes secrets, tokens, and absolute paths', () => {
  const redacted = redactSensitive('key=test-secret token=abc123 /tmp/private', {
    secret: 'test-secret',
    tokens: ['abc123'],
    paths: ['/tmp/private'],
  });
  assert.equal(redacted.includes('test-secret'), false);
  assert.equal(redacted.includes('abc123'), false);
  assert.equal(redacted.includes('/tmp/private'), false);
  assert.equal(redactSensitive('{"token":"quoted-secret"}').includes('quoted-secret'), false);
  assert.equal(redactSensitive('{\\"token\\":\\"escaped-secret\\"}').includes('escaped-secret'), false);
  assert.equal(containsSensitive('Authorization: Bearer long-lived-secret-value'), true);
  assert.equal(redactSensitive('Authorization: Bearer long-lived-secret-value'), 'Authorization=<redacted>');
});

class FakeBrowser implements BrowserClient {
  readonly events: string[] = [];
  private selected = false;
  private submitted = false;

  constructor(private readonly command: string, private readonly openedUrls: string[]) {}

  async open(url: string): Promise<void> {
    this.openedUrls.push(url);
    this.events.push('open');
  }

  async setCookieFile(path: string): Promise<void> {
    this.events.push(`cookie:${path}`);
  }
  async keyboardType(text: string): Promise<void> {
    this.events.push(`type:${text}`);
  }

  async press(key: string): Promise<void> {
    this.events.push(`press:${key}`);
    if (key === 'Tab') this.selected = true;
    if (key === 'Enter') this.submitted = true;
  }

  async evaluate(_script: string): Promise<string> {
    if (!this.selected) return JSON.stringify(`❯ ${this.command}`);
    if (!this.submitted) return JSON.stringify(`/${this.command}`);
    return JSON.stringify(`${this.command}: STARTED`);
  }

  async close(): Promise<void> {
    this.events.push('close');
  }
}
test('AI runner drives picker, Tab, CR/Enter, and cleanup for every command with injected seams', async () => {
  const workdir = temporaryDirectory('ai-runner-');
  const outputDir = join(workdir, 'artifacts');
  const events: string[] = [];
  const browsers = new Map<string, FakeBrowser>();
  const openedUrls: string[] = [];
  const startedOptions: TestSessionOptions[] = [];
  const dependencies = {
    bootstrap: (args: { readonly workdir: string }): string => {
      const scratch = join(args.workdir, `scratch-${browsers.size}`);
      mkdirSync(join(scratch, '.omp'), { recursive: true });
      events.push('bootstrap');
      return scratch;
    },
    start: async (options: TestSessionOptions): Promise<TestSession> => {
      startedOptions.push(options);
      events.push(`start:${options.cwd}`);
      return {
        host: '127.0.0.1',
        publicHost: '127.0.0.1',
        port: 1234,
        token: 'session-token',
        url: 'http://127.0.0.1:1234/?token=session-token',
        browserUrl: 'http://127.0.0.1:1234/',
        wsPath: '/ws',
        scratchDir: options.cwd,
        transcriptPath: join(options.cwd, 'transcript.jsonl'),
        sessionJsonPath: join(options.cwd, 'session.json'),
        pty: { pid: null, cols: 100, rows: 30, mode: 'noPty' },
        close: async () => {
          events.push('session-close');
        },
      };
    },
    browser: (sessionName: string): FakeBrowser => {
      const command = sessionName.replace(/^ai-test-run-/, '');
      const browser = new FakeBrowser(command, openedUrls);
      browsers.set(command, browser);
      return browser;
    },
    sleep: async (): Promise<void> => undefined,
    now: () => Date.now(),
  };
  const report = await runAiCommandMatrix({
    monorepoRoot: resolve(defaultMonorepoRoot()),
    workdir,
    outputDir,
    runId: 'test-run',
    env: {
      OMP_API_PROVIDER: 'opencode-go',
      OMP_BASE_MODEL: 'deepseek-v4-flash',
      OMP_VISUAL_MODEL: 'minimax-m3',
      OPENCODE_API_KEY: 'test-secret-key',
    },
    typingDelayMs: 0,
    startGraceMs: 0,
    perCommandTimeoutMs: 10_000,
    startupTimeoutMs: 2_000,
    pickerTimeoutMs: 2_000,
    startTimeoutMs: 2_000,
  }, dependencies);
  assert.equal(report.status, 'passed');
  assert.equal(report.cases.length, 7);
  assert.ok(report.cases.every(item => item.status === 'passed'));
  assert.ok(events.includes('session-close'));
  assert.ok([...browsers.values()].every(browser => browser.events.includes('press:Tab')));
  assert.ok([...browsers.values()].every(browser => browser.events.includes('press:Enter')));
  assert.ok(openedUrls.every(url => !url.includes('token=')));
  assert.ok(startedOptions.every(options => options.inheritEnv === false && options.hostConfigPath === null));
  assert.ok(startedOptions.every(options => options.env?.HOME?.includes('/.home') === true));
});
