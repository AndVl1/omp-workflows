#!/usr/bin/env bun
// Real OMP SDK ordinary-task lineage regression. The only scripted
// boundary is the offline model transport; SDK tools, sessions, event bus,
// lifecycle, source registration, and workflow authority all run for real.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const stateSymbol = 'omp-workflows.ordinary-task-sdk-lineage.fixture';
const outputMarker = '@@ORDINARY_TASK_SDK_LINEAGE@@';

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function contextMessages(context) {
  return Array.isArray(context?.messages) ? context.messages.filter(isRecord) : [];
}

function textOfMessage(message) {
  if (!Array.isArray(message.content)) return '';
  return message.content.map((part) => isRecord(part) && typeof part.text === 'string' ? part.text : '').join('\n');
}

function toolResponse(name, id, args) {
  return { content: [{ type: 'toolCall', id, name, arguments: args }] };
}

function makeUiContext() {
  return {
    select: async () => 'proceed',
    confirm: async () => false,
    input: async () => undefined,
    askDialog: async () => undefined,
    notify: () => {},
    onTerminalInput: () => () => {},
    setStatus: () => {},
    setWorkingMessage: () => {},
    setWidget: () => {},
    setFooter: () => {},
    setHeader: () => {},
    setTitle: () => {},
    custom: async () => undefined,
    setEditorText: () => {},
    pasteToEditor: () => {},
    getEditorText: () => '',
    editor: async () => undefined,
    addAutocompleteProvider: () => {},
    setEditorComponent: () => {},
    theme: {},
    getAllThemes: async () => [],
    getTheme: async () => undefined,
    setTheme: async () => ({ success: false, error: 'No visual theme in the isolated SDK fixture' }),
    getToolsExpanded: () => false,
    setToolsExpanded: () => {},
  };
}

function makeExtensionSource(coreUrl) {
  return `import { registerTeamWorkflow, registerWorkflowTools } from ${JSON.stringify(coreUrl)};
const stateKey = Symbol.for(${JSON.stringify(stateSymbol)});
function managerCwd(context) {
  const manager = context && typeof context === 'object' ? context.sessionManager : undefined;
  if (!manager || typeof manager.getCwd !== 'function') return undefined;
  try { return manager.getCwd(); } catch { return undefined; }
}
function isAuthenticatedRoot(context, cwd, state) {
  return Boolean(
    state.rootStarted && context && typeof context === 'object' &&
    context.sessionManager === state.rootManager &&
    managerCwd(context) === state.workspace && cwd === state.workspace &&
    context.mode === 'tui' && context.hasUI === true
  );
}
export default function ordinaryTaskSdkLineageExtension(pi) {
  const state = globalThis[stateKey];
  if (!state) throw new Error('ordinary SDK fixture state was not installed before extension load');
  state.extensionFactoryLoads += 1;
  pi.registerProvider(state.providerRegistration.name, state.providerRegistration.config);
  pi.events.on('task:subagent:lifecycle', (event) => { state.lifecycleEvents.push(event); });
  const resolveCwd = managerCwd;
  const getSessionController = (context, cwd) =>
    isAuthenticatedRoot(context, cwd, state) ? state.controller : undefined;
  const resolveTrustedToolCallActor = (context, cwd, runId) => {
    if (!isAuthenticatedRoot(context, cwd, state) || runId !== undefined) return undefined;
    if (state.controller.context().session_id !== state.rootManager.getSessionId()) return undefined;
    return { kind: 'authenticated-interactive-host-no-run' };
  };
  // Observe real SDK session identities only; never synthesize or suppress a
  // lifecycle event. This also records the actual SessionManager per session.
  pi.on('session_start', (_event, context) => {
    const manager = context && typeof context === 'object' ? context.sessionManager : undefined;
    if (!manager || typeof manager.getSessionId !== 'function' || typeof manager.getSessionFile !== 'function') return;
    const header = typeof manager.getHeader === 'function' ? manager.getHeader() : undefined;
    state.sessions.push({
      manager,
      sessionId: manager.getSessionId(),
      sessionFile: manager.getSessionFile(),
      cwd: managerCwd(context),
      parentSession: header && typeof header.parentSession === 'string' ? header.parentSession : undefined,
      mode: context.mode,
      hasUI: context.hasUI,
    });
    if (manager === state.rootManager) state.rootStarted = true;
  });
  const registration = {
    observability: false,
    roles: { developer: 'ordinary-lineage-worker' },
    scopeMap: [{ glob: ['**/*'], scope: 'backend', dev_agent: 'ordinary-lineage-worker' }],
    resolveCwd,
    getSessionController,
    resolveTrustedToolCallActor,
  };
  registerTeamWorkflow(pi, registration);
  registerWorkflowTools(pi, { resolveCwd });
}
`;
}

function findToolResult(model, toolCallId) {
  for (const call of model.calls) {
    for (const message of contextMessages(call.context)) {
      if (message.role === 'toolResult' && message.toolCallId === toolCallId) return message;
    }
  }
  return undefined;
}

function messageText(message) {
  return isRecord(message) ? textOfMessage(message) : '';
}

function requireToolResult(assert, model, toolCallId) {
  const result = findToolResult(model, toolCallId);
  assert.ok(result, 'real SDK transcript is missing tool result ' + toolCallId);
  return result;
}

function lifecycleFor(state, parentToolCallId, status) {
  const matches = state.lifecycleEvents.filter((event) =>
    isRecord(event) && event.parentToolCallId === parentToolCallId && event.status === status,
  );
  const first = matches[0];
  if (!first || matches.some((event) =>
    event.id !== first.id || event.agent !== first.agent || event.index !== first.index || event.sessionFile !== first.sessionFile,
  )) throw new Error(`missing or conflicting real ${status} lifecycle for ${parentToolCallId}`);
  return first;
}

function asErrorText(error) {
  return error instanceof Error ? error.stack ?? error.message : String(error);
}

async function run() {
  const assert = (await import('node:assert/strict')).default;
  const repositoryRoot = resolve(process.argv[2] ?? process.cwd());
  const inheritedPath = process.env.PATH ?? '/usr/bin:/bin';
  const inheritedTmp = process.env.TMPDIR ?? '/tmp';
  for (const key of Object.keys(process.env)) delete process.env[key];

  const scratch = process.argv[3] ? resolve(process.argv[3]) : mkdtempSync(join(inheritedTmp, 'omp-ordinary-task-sdk-lineage-'));
  const home = join(scratch, 'home');
  const workspace = join(scratch, 'workspace');
  const sessionDir = join(scratch, 'sessions');
  const agentDir = join(scratch, 'agent');
  const configDir = join(scratch, 'config');
  const cacheDir = join(scratch, 'cache');
  const authDir = join(scratch, 'auth');
  for (const directory of [home, workspace, sessionDir, agentDir, configDir, cacheDir, authDir]) {
    mkdirSync(directory, { recursive: true });
  }
  Object.assign(process.env, {
    PATH: inheritedPath,
    TMPDIR: scratch,
    HOME: home,
    XDG_CONFIG_HOME: join(home, '.config'),
    XDG_CACHE_HOME: join(home, '.cache'),
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
    GIT_TERMINAL_PROMPT: '0',
    PI_NO_TITLE: '1',
    LANG: 'C',
  });
  mkdirSync(process.env.XDG_CONFIG_HOME, { recursive: true });
  mkdirSync(process.env.XDG_CACHE_HOME, { recursive: true });

  const networkAttempts = [];
  const originalFetch = globalThis.fetch;
  const networkDenied = async (input) => {
    networkAttempts.push(String(input));
    throw new Error('Network is disabled in the ordinary-task SDK fixture');
  };
  globalThis.fetch = networkDenied;

  const apiSourceId = join(scratch, 'ordinary-task-sdk-lineage.extension.mjs');
  const sourceState = {
    rootManager: undefined,
    rootStarted: false,
    controller: undefined,
    workspace,
    extensionFactoryLoads: 0,
    sessions: [],
    lifecycleEvents: [],
  };
  globalThis[Symbol.for(stateSymbol)] = sourceState;

  let session;
  let authStorage;
  let eventBus;
  let asyncJobManager;
  let apiRegistry;
  let primaryError;
  let report;
  const cleanupErrors = [];
  let teardownPromise;
  let unregisterPostmortem;
  const cleanup = async (label, operation) => {
    try { await operation(); } catch (error) { cleanupErrors.push(label + ': ' + asErrorText(error)); }
  };
  const teardown = () => teardownPromise ??= (async () => {
    const manager = asyncJobManager ?? await import(pathToFileURL(join(repositoryRoot, 'node_modules/@oh-my-pi/pi-coding-agent/src/async/job-manager.ts')).href)
      .then((module) => module.AsyncJobManager.instance()).catch(() => undefined);
    if (manager) {
      await cleanup('AsyncJobManager disposal', async () => {
        manager.cancelAll();
        const drained = await manager.dispose({ timeoutMs: 5_000 });
        if (!drained) throw new Error('actual SDK jobs or deliveries did not drain before cleanup');
      });
      try {
        const module = await import(pathToFileURL(join(repositoryRoot, 'node_modules/@oh-my-pi/pi-coding-agent/src/async/job-manager.ts')).href);
        module.AsyncJobManager.setInstance(undefined);
      } catch (error) {
        cleanupErrors.push('AsyncJobManager singleton reset: ' + asErrorText(error));
      }
    }
    if (session) await cleanup('AgentSession disposal', () => session.dispose());
    if (authStorage) await cleanup('AuthStorage close', () => authStorage.close());
    if (apiRegistry) await cleanup('scripted provider unregister', () => apiRegistry.unregisterCustomApis(apiSourceId));
    if (eventBus) await cleanup('EventBus clear', () => eventBus.clear());
    globalThis.fetch = originalFetch;
    delete globalThis[Symbol.for(stateSymbol)];
    await cleanup('private scratch removal', () => rmSync(scratch, { recursive: true, force: true }));
  })();

  try {
    const hostPackage = JSON.parse(readFileSync(join(repositoryRoot, 'node_modules/@oh-my-pi/pi-coding-agent/package.json'), 'utf8'));
    assert.equal(hostPackage.name, '@oh-my-pi/pi-coding-agent');

    const sdkRoot = join(repositoryRoot, 'node_modules/@oh-my-pi/pi-coding-agent');
    const aiRoot = join(repositoryRoot, 'node_modules/@oh-my-pi/pi-ai');
    const coreUrl = pathToFileURL(join(repositoryRoot, 'packages/core/src/index.ts')).href;
    const [{ Settings, SessionManager, AuthStorage, ModelRegistry, createAgentSession }, mockModule, apiRegistryModule, eventBusModule, runtimeInitModule, jobManagerModule, core] = await Promise.all([
      import('@oh-my-pi/pi-coding-agent'),
      import('@oh-my-pi/pi-ai/providers/mock'),
      import(pathToFileURL(join(aiRoot, 'src/api-registry.ts')).href),
      import(pathToFileURL(join(sdkRoot, 'src/utils/event-bus.ts')).href),
      import(pathToFileURL(join(sdkRoot, 'src/modes/runtime-init.ts')).href),
      import(pathToFileURL(join(sdkRoot, 'src/async/job-manager.ts')).href),
      import(coreUrl),
    ]);
    apiRegistry = apiRegistryModule;
    const postmortem = await import(pathToFileURL(join(repositoryRoot, 'node_modules/@oh-my-pi/pi-utils/src/postmortem.ts')).href);
    unregisterPostmortem = postmortem.register('ordinary-sdk-fixture', teardown);
    const { EventBus } = eventBusModule;
    const { initializeExtensions } = runtimeInitModule;
    const { AsyncJobManager } = jobManagerModule;
    const { createMockModel } = mockModule;

    const runGit = (args) => execFileSync('git', args, { cwd: workspace, stdio: 'pipe', env: process.env });
    mkdirSync(join(workspace, '.omp', 'agents'), { recursive: true });
    mkdirSync(join(workspace, 'packages/core'), { recursive: true });
    mkdirSync(join(workspace, 'packages/fullstack'), { recursive: true });
    writeFileSync(join(workspace, 'package.json'), JSON.stringify({ name: 'ordinary-task-sdk-lineage-fixture', private: true }) + '\n');
    writeFileSync(join(workspace, 'packages/core', '.fixture'), 'core source marker\n');
    writeFileSync(join(workspace, 'packages/fullstack', '.fixture'), 'fullstack marker\n');
    writeFileSync(join(workspace, '.omp/team.config.json'), JSON.stringify({
      roles: { developer: 'ordinary-lineage-worker' },
      scope_map: [{ glob: ['**/*'], scope: 'backend', dev_agent: 'ordinary-lineage-worker' }],
    }) + '\n');
    writeFileSync(join(workspace, '.omp/agents/ordinary-lineage-worker.md'), [
      '---',
      'name: ordinary-lineage-worker',
      'description: Deterministic agent for the isolated ordinary SDK lineage regression',
      'model: @task',
      'tools: read, write, edit, bash, task',
      'spawns: *',
      'blocking: true',
      'prewalk: false',
      'advisor: false',
      '---',
      'Execute only the finite local file operations requested in the task. Do not use network or workflow tools.',
      '',
    ].join('\n'));
    runGit(['init', '--quiet', '--initial-branch=main']);
    runGit(['config', 'user.name', 'OMP ordinary SDK fixture']);
    runGit(['config', 'user.email', 'omp-ordinary-sdk@example.invalid']);
    runGit(['add', '--all']);
    runGit(['commit', '--quiet', '-m', 'private ordinary task SDK fixture']);
    const branch = execFileSync('git', ['branch', '--show-current'], { cwd: workspace, encoding: 'utf8', env: process.env }).trim();

    const extensionPath = join(scratch, 'ordinary-task-sdk-lineage.extension.mjs');
    writeFileSync(extensionPath, makeExtensionSource(coreUrl), 'utf8');

    const providerName = 'omp-ordinary-task-lineage';
    const modelId = 'scripted-offline';
    const modelSelector = providerName + '/' + modelId;
    const modelApi = 'ordinary-task-lineage-scripted';
    const modelResponses = [
      () => toolResponse('task', 'root-task-call', {
        agent: 'ordinary-lineage-worker',
        task: 'Write child-lineage.txt, read it, hashline-edit before to after, prove the value with bash, attempt one denied canonical write, then run the real nested ordinary task.',
      }),
      () => toolResponse('write', 'child-write', { path: 'child-lineage.txt', content: 'before' }),
      () => toolResponse('read', 'child-read', { path: 'child-lineage.txt' }),
      (context) => {
        const read = contextMessages(context).find((message) => message.role === 'toolResult' && message.toolCallId === 'child-read');
        const output = read ? textOfMessage(read) : '';
        const marker = 'child-lineage.txt#';
        const markerAt = output.indexOf(marker);
        if (markerAt < 0) throw new Error('real SDK read result did not provide the child file hashline snapshot');
        const tag = output.slice(markerAt + marker.length, markerAt + marker.length + 4);
        if (tag.length !== 4 || [...tag].some((character) => !'0123456789abcdefABCDEF'.includes(character))) {
          throw new Error('real SDK read result supplied an invalid child hashline tag: ' + tag);
        }
        return toolResponse('edit', 'child-hashline-edit', {
          input: '[child-lineage.txt#' + tag + ']\nPUT 1.=1:\n+after',
        });
      },
      () => toolResponse('bash', 'child-bash-assert', {
        command: 'grep -Fx after child-lineage.txt && printf CHILD_VALUE_ASSERT_OK',
      }),
      () => toolResponse('write', 'canonical-write-attempt', {
        path: '.work-state/run-control.json',
        content: '{"schema":2,"execution_claim":null}',
      }),
      () => toolResponse('task', 'nested-task-call', {
        agent: 'ordinary-lineage-worker',
        task: 'Write grandchild-lineage.txt with grandchild, then prove its exact value with bash.',
      }),
      () => toolResponse('write', 'grandchild-write', { path: 'grandchild-lineage.txt', content: 'grandchild' }),
      () => toolResponse('bash', 'grandchild-bash-assert', {
        command: 'grep -Fx grandchild grandchild-lineage.txt && printf GRANDCHILD_VALUE_ASSERT_OK',
      }),
      () => toolResponse('yield', 'grandchild-finish', { result: { data: { summary: 'Grandchild ordinary task completed.' } } }),
      () => toolResponse('yield', 'child-finish', { result: { data: { summary: 'Child ordinary task completed after its nested task.' } } }),
      () => ({ content: ['Ordinary nested task lineage completed.'] }),
    ];
    const scriptedModel = createMockModel({ id: modelId, provider: providerName, responses: modelResponses });

    const settings = Settings.isolated({
      modelRoles: { default: modelSelector, task: modelSelector },
      'async.enabled': true,
      'task.isolation.mode': 'none',
      'task.maxConcurrency': 1,
      'task.maxRecursionDepth': 3,
      'task.maxRuntimeMs': 30_000,
      'edit.mode': 'hashline',
    });
    authStorage = await AuthStorage.create(join(authDir, 'auth.sqlite'), {
      usageFetch: networkDenied,
      fetchUsageReports: async () => null,
    });
    const modelRegistry = new ModelRegistry(authStorage, join(configDir, 'models.yml'), {
      settings,
      cacheDbPath: join(cacheDir, 'models.sqlite'),
      fetch: networkDenied,
    });
    const providerConfig = {
      api: modelApi,
      baseUrl: 'https://offline.invalid',
      apiKey: 'offline-fixture-no-network',
      streamSimple: (_model, context, options) => scriptedModel.stream(scriptedModel, context, options),
      models: [{
        id: modelId,
        name: 'Offline scripted ordinary lineage model',
        reasoning: false,
        input: ['text'],
        supportsTools: true,
        contextWindow: 32768,
        maxTokens: 4096,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      }],
    };
    sourceState.providerRegistration = { name: providerName, config: providerConfig };
    modelRegistry.registerProvider(providerName, providerConfig, extensionPath);
    assert.equal(modelRegistry.getError(), undefined, 'isolated scripted model registration must load');
    const model = modelRegistry.getAvailable().find((candidate) => candidate.provider === providerName && candidate.id === modelId);
    assert.ok(model, 'the real SDK ModelRegistry must resolve the offline scripted model');

    const rootSessionFile = join(sessionDir, 'root.jsonl');
    const rootManager = await SessionManager.open(rootSessionFile, sessionDir, undefined, {
      initialCwd: workspace,
      suppressBreadcrumb: true,
    });
    sourceState.rootManager = rootManager;
    sourceState.controller = core.createWorkflowSessionController({
      cwd: workspace,
      context: {
        session_id: rootManager.getSessionId(),
        caller: 'host',
        process_id: process.pid,
        worktree: workspace,
        branch,
        authority: 'coordinator',
      },
    });
    eventBus = new EventBus();

    const settingsModelPattern = modelSelector;
    assert.equal(settings.getModelRole('task'), settingsModelPattern);
    const created = await createAgentSession({
      cwd: workspace,
      agentDir,
      sessionManager: rootManager,
      eventBus,
      settings,
      authStorage,
      modelRegistry,
      model,
      spawns: '*',
      toolNames: ['read', 'write', 'edit', 'bash', 'task'],
      autoApprove: true,
      hasUI: true,
      enableMCP: false,
      enableLsp: false,
      enableIrc: false,
      skipPythonPreflight: true,
      disableExtensionDiscovery: true,
      preloadedExtensionPaths: [extensionPath],
      contextFiles: [],
      skills: [],
      rules: [],
      slashCommands: [],
    });
    session = created.session;
    eventBus = created.eventBus;
    const uiContext = makeUiContext();
    created.setToolUIContext(uiContext, true);
    const extensionErrors = [];
    const sendErrors = [];
    await initializeExtensions(session, {
      mode: 'tui',
      uiContext,
      reportSendError: (action, error) => { sendErrors.push(action + ': ' + error.message); },
      reportRuntimeError: (error) => { extensionErrors.push(error); },
    });
    assert.equal(sourceState.rootStarted, true, 'the actual interactive Root session_start must bind the shared controller');

    const actualManager = AsyncJobManager.instance();
    assert.ok(actualManager, 'real SDK creation must install its process AsyncJobManager');
    asyncJobManager = actualManager;
    await session.prompt('Run the one finite local ordinary-task lineage regression.');
    assert.deepEqual(extensionErrors, [], 'source core extension hooks must complete without runtime errors');
    assert.deepEqual(sendErrors, [], 'source core extension hooks must not fail to send host messages');

    const toolResult = (id) => requireToolResult(assert, scriptedModel, id);
    const childWrite = toolResult('child-write');
    const childRead = toolResult('child-read');
    const childEdit = toolResult('child-hashline-edit');
    const childBash = toolResult('child-bash-assert');
    const canonicalAttempt = toolResult('canonical-write-attempt');
    const nestedTask = toolResult('nested-task-call');
    const rootTask = toolResult('root-task-call');
    assert.equal(rootTask.details?.results?.[0]?.exitCode, 0, JSON.stringify(rootTask.details));
    assert.equal(nestedTask.details?.results?.[0]?.exitCode, 0, JSON.stringify(nestedTask.details));
    const grandchildWrite = toolResult('grandchild-write');
    const grandchildBash = toolResult('grandchild-bash-assert');
    const successful = (result) => result.isError !== true;
    assert.ok(successful(childWrite), 'the real child SDK write tool must create its file');
    assert.ok(successful(childRead) && messageText(childRead).includes('before'), 'the real child SDK read must return the written value');
    assert.ok(successful(childEdit), 'the real hashline edit tool must accept the tag returned by the real read tool');
    assert.ok(successful(childBash) && messageText(childBash).includes('CHILD_VALUE_ASSERT_OK'), 'real Bash must assert the edited value');
    assert.equal(canonicalAttempt.isError, true, 'the canonical state write must be rejected by the real core hook');
    assert.ok(successful(nestedTask), 'the ordinary child must be able to invoke an actual nested TaskTool');
    assert.ok(successful(grandchildWrite), 'the real grandchild SDK write tool must create its file');
    assert.ok(successful(grandchildBash) && messageText(grandchildBash).includes('GRANDCHILD_VALUE_ASSERT_OK'), 'real grandchild Bash must assert its value');

    const childBytes = readFileSync(join(workspace, 'child-lineage.txt'), 'utf8');
    const grandchildBytes = readFileSync(join(workspace, 'grandchild-lineage.txt'), 'utf8');
    assert.equal(childBytes, 'after', 'the four child consumer operations must leave the exact edited bytes');
    assert.equal(grandchildBytes, 'grandchild', 'the actual grandchild must leave the exact written bytes');
    const controlPath = join(workspace, '.work-state/run-control.json');
    const runsPath = join(workspace, '.work-state/runs');
    assert.equal(existsSync(controlPath), false, 'denied consumer write must not create canonical run-control state');
    assert.equal(existsSync(runsPath), false, 'ordinary TaskTool lineage must not create canonical workflow runs');
    assert.equal(sourceState.controller.selectedRunId(), undefined, 'ordinary Root must remain without a selected workflow');
    assert.equal(sourceState.controller.activeClaimRunId(), undefined, 'ordinary Root must remain without an execution claim');

    const rootChildStart = lifecycleFor(sourceState, 'root-task-call', 'started');
    const rootChildEnd = lifecycleFor(sourceState, 'root-task-call', 'completed');
    const grandchildStart = lifecycleFor(sourceState, 'nested-task-call', 'started');
    const grandchildEnd = lifecycleFor(sourceState, 'nested-task-call', 'completed');
    assert.equal(rootChildStart.sessionFile, rootChildEnd.sessionFile);
    assert.equal(grandchildStart.sessionFile, grandchildEnd.sessionFile);
    const sessionForFile = (sessionFile) => sourceState.sessions.find((entry) => entry.sessionFile === sessionFile);
    const rootRecord = sourceState.sessions.find((entry) => entry.manager === rootManager);
    const childRecord = sessionForFile(rootChildStart.sessionFile);
    const grandchildRecord = sessionForFile(grandchildStart.sessionFile);
    assert.ok(rootRecord && childRecord && grandchildRecord, 'real SDK lifecycle files must match real session_start managers');
    assert.equal(rootRecord.cwd, workspace);
    assert.equal(childRecord.cwd, workspace);
    assert.equal(grandchildRecord.cwd, workspace);
    assert.notEqual(rootRecord.manager, childRecord.manager);
    assert.notEqual(childRecord.manager, grandchildRecord.manager);
    assert.notEqual(rootRecord.sessionId, childRecord.sessionId);
    assert.notEqual(childRecord.sessionId, grandchildRecord.sessionId);
    assert.ok(rootRecord.sessionFile && childRecord.sessionFile && grandchildRecord.sessionFile);

    const transcriptMessages = scriptedModel.calls.flatMap((call) => contextMessages(call.context));
    const workflowToolCalls = new Set(transcriptMessages
      .filter((message) => message.role === 'toolResult' && typeof message.toolName === 'string' && message.toolName.startsWith('workflow_'))
      .map((message) => message.toolName));
    assert.equal(workflowToolCalls.size, 0, 'the scenario must not invoke workflow prepare, run, claim, or publication tools');
    assert.equal(actualManager.getRunningJobs().length, 0, 'blocking real TaskTool workers must leave no live async SDK jobs');

    report = {
      verdict: 'PASS',
      sdkVersion: hostPackage.version,
      bunVersion: process.versions.bun,
      extensionFactoryLoads: sourceState.extensionFactoryLoads,
      sessions: { root: true, child: true, grandchild: true, distinctManagers: true },
      operations: {
        childWrite: successful(childWrite),
        childRead: successful(childRead) && messageText(childRead).includes('before'),
        childHashlineEdit: successful(childEdit) && childBytes === 'after',
        childBashValueAssertion: successful(childBash) && messageText(childBash).includes('CHILD_VALUE_ASSERT_OK'),
        canonicalWriteDenied: canonicalAttempt.isError === true && !existsSync(controlPath),
        nestedTaskCompleted: successful(nestedTask) && grandchildEnd.status === 'completed',
        grandchildWrite: successful(grandchildWrite) && grandchildBytes === 'grandchild',
        grandchildBashValueAssertion: successful(grandchildBash) && messageText(grandchildBash).includes('GRANDCHILD_VALUE_ASSERT_OK'),
      },
      finalBytes: { child: childBytes, grandchild: grandchildBytes },
      workflowState: {
        selectedRunAbsent: sourceState.controller.selectedRunId() === undefined,
        executionClaimAbsent: sourceState.controller.activeClaimRunId() === undefined,
        runControlAbsent: !existsSync(controlPath),
        runsDirectoryAbsent: !existsSync(runsPath),
        workflowToolCalls: workflowToolCalls.size,
      },
      asyncJobs: { managerPresent: true, running: actualManager.getRunningJobs().length },
      scriptedModelCalls: scriptedModel.calls.length,
      networkAttempts: networkAttempts.length,
    };
  } catch (error) {
    primaryError = error;
  } finally {
    await teardown();
    unregisterPostmortem?.();
  }

  if (cleanupErrors.length > 0 && !primaryError) primaryError = new Error(cleanupErrors.join('\n'));
  if (primaryError) {
    console.error(outputMarker + JSON.stringify({ verdict: 'FAIL', error: asErrorText(primaryError), cleanupErrors }));
    process.exitCode = 1;
    return;
  }
  console.log(outputMarker + JSON.stringify(report));
}

if (import.meta.main) await run();
