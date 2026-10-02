import { run as runTests } from 'node:test';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const script = fileURLToPath(import.meta.url);
const root = resolve(dirname(script), '..');
const suites = {
  // Long suites start first. node --test sorts CLI paths; the worker uses the
  // programmatic runner to preserve this order with at most three files in flight.
  D: [
    'packages/fullstack/test/workflow-tools.test.ts',
    'packages/core/test/reliable-stage-loop.test.ts',
    'packages/core/test/reliable-stage-recovery-registered.test.ts',
    'packages/core/test/reliable-stage-gates.test.ts',
    'packages/core/test/reliable-stage-lifecycle.test.ts',
    'packages/core/test/reliable-stage-ordinary-sdk-terminal.test.ts',
    'packages/core/test/reliable-stage-execution-producers.test.ts',
    'packages/core/test/reliable-stage-execution.test.ts',
    'packages/omp-workflows-internal/test/workflow-registration-scenarios.test.ts',
    'packages/core/test/reliable-stage-renderer.test.ts',
  ],
  P: ['packages/core/test/reliable-stage-execution-process.test.ts'],
};

export function scenarioEnvironment(temporary, level, sourceSha256) {
  // Inherit runtime essentials, not provider credentials, config selectors, or
  // preload/library overrides. A secret-name denylist misses credential chains.
  const environment = {};
  for (const key of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'PATHEXT', 'LANG', 'LC_ALL', 'TZ']) {
    if (process.env[key] !== undefined) environment[key] = process.env[key];
  }
  return {
    ...environment,
    CI: 'true',
    NO_COLOR: '1',
    HOME: temporary,
    USERPROFILE: temporary,
    APPDATA: temporary,
    LOCALAPPDATA: temporary,
    TMPDIR: temporary,
    TMP: temporary,
    TEMP: temporary,
    XDG_CONFIG_HOME: temporary,
    XDG_CACHE_HOME: temporary,
    XDG_DATA_HOME: temporary,
    XDG_STATE_HOME: temporary,
    XDG_RUNTIME_DIR: temporary,
    OMP_HOME: temporary,
    PI_CODING_AGENT_DIR: temporary,
    PI_CONFIG_DIR: temporary,
    NODE_OPTIONS: `--import=${pathToFileURL(join(root, 'scripts/workflow-offline.mjs')).href}`,
    WORKFLOW_SCENARIO_LEVEL: level,
    WORKFLOW_SOURCE_SHA256: sourceSha256,
  };
}

function requiredCases(level) {
  const cases = [];
  const add = (id, routes = ['O', 'C']) => routes.forEach(route => cases.push(`${route}:${id}`));
  if (level === 'D') {
    for (let i = 1; i <= 15; i++) add(`S${String(i).padStart(2, '0')}`);
    add('S16', ['O']);
    add('S17', ['O']);
    for (let i = 1; i <= 24; i++) {
      add(`R${String(i).padStart(2, '0')}`, [19, 20, 22].includes(i) ? ['C'] : i === 23 ? ['O'] : ['O', 'C']);
    }
    add('R25', ['O']);
    add('A01');
    add('A02');
    for (const id of ['A11', 'A12', 'A13']) add(id);
    add('A14', ['O']);
    add('A15', ['O']);
  } else {
    for (const id of ['S06', 'S08', 'R02', 'R09', 'R13', 'R14', 'R24']) add(id);
    add('R22', ['C']);
  }
  return cases;
}

// A content fingerprint includes uncommitted candidate edits, unlike HEAD alone.
async function sourceDigest(directory = root, hash = createHash('sha256')) {
  const entries = await readdir(directory, { withFileTypes: true });
  entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
  for (const entry of entries) {
    if (['node_modules', 'dist', '.git', '.work-state', '.beads', 'openspec'].includes(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (directory !== root || ['packages', 'scripts', '.github'].includes(entry.name)) await sourceDigest(path, hash);
    } else if (entry.isFile() && /\.(?:[cm]?[jt]s|json|md|ya?ml)$/.test(entry.name)) {
      hash.update(path.slice(root.length + 1)).update('\0').update(await readFile(path)).update('\0');
    }
  }
  return hash;
}

const SCENARIO_TRACE_PREFIX = '@@OMP_SCENARIO_TRACE@@';
const TRACE_EVENT_KINDS = [
  'workflow_registered', 'workflow_started', 'workflow_completed',
  'stage_registered', 'stage_entered', 'stage_exited', 'stage_submitted',
  'tool_registered', 'tool_called', 'tool_completed',
  'worker_admitted', 'worker_started', 'worker_completed', 'worker_failed',
  'attempt_started', 'attempt_completed', 'revision_created', 'revision_published',
  'verdict_recorded', 'count_recorded', 'checkpoint_issued', 'checkpoint_accepted',
  'checkpoint_rejected', 'artifact_published', 'fault_injected', 'fault_observed',
  'barrier_wait', 'barrier_released', 'barrier_timeout',
  'recovery_diagnosed', 'recovery_reconciled', 'retry_started', 'retry_completed',
  'run_completed',
];
const TRACE_VERDICTS = ['PASS', 'FAIL', 'BLOCKED', 'RETRY', 'PENDING', 'ACCEPT', 'REJECT', 'UNKNOWN'];
const TRACE_OUTCOMES = ['PASS', 'FAIL', 'BLOCKED', 'RETRY', 'PENDING', 'STARTED', 'COMPLETED', 'ACCEPTED', 'REJECTED', 'NOT_STARTED', 'TIMEOUT', 'CANCELLED', 'UNKNOWN'];
const TRACE_FAULT_POINTS = ['registration', 'preflight', 'admission', 'validation', 'execution', 'submission', 'publication', 'checkpoint', 'recovery', 'barrier', 'cleanup', 'process', 'transport', 'race', 'restart', 'crash', 'terminal', 'identity', 'ownership', 'foreign', 'replay', 'corruption', 'network', 'unknown'];
const TRACE_IDENTITY_KEYS = ['run', 'stage', 'attempt', 'revision', 'worker', 'dispatch', 'checkpoint', 'barrier', 'task', 'receipt'];
const TRACE_LINK_KEYS = [...TRACE_IDENTITY_KEYS, 'parent', 'child', 'run_of', 'stage_of', 'attempt_of', 'revision_of', 'retry_of', 'checkpoint_of', 'dispatch_of', 'worker_of', 'cause', 'source', 'target'];
const TRACE_SEMANTIC = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const TRACE_FILE = /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/;
const TRACE_EVENT_KEYS = ['sequence', 'route', 'kind', 'workflow', 'stage', 'phase', 'tool', 'identities', 'links', 'attempt', 'revision', 'verdict', 'outcome', 'count', 'faultPoint', 'barrier', 'source'];
const TRACE_ENVELOPE_KEYS = ['version', 'scenario_ids', 'source', 'truncated', 'events'];

function safeTraceInteger(value, maximum) {
  return Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function safeTraceSemantic(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512) return undefined;
  if (!TRACE_SEMANTIC.test(value) || /(?:token|secret|password|credential)/i.test(value) || /^[0-9a-f]{32,}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return undefined;
  return value;
}

function safeTraceTag(value) {
  return typeof value === 'string' && /^(?:O|C):(?:S|R|A)\d{2}$/.test(value) ? value : undefined;
}

function safeTraceFile(value) {
  if (typeof value !== 'string' || value.length === 0 || value.length > 256) return undefined;
  const normalized = value.replaceAll('\\', '/');
  if (!normalized.startsWith('/')) {
    return !normalized.includes('..') && TRACE_FILE.test(normalized) ? normalized : undefined;
  }
  const absolute = resolve(normalized);
  const roots = [root];
  if (root.startsWith('/private/')) roots.push(root.slice('/private'.length));
  else roots.push(`/private${root}`);
  for (const candidateRoot of roots) {
    const candidate = relative(candidateRoot, absolute).replaceAll('\\', '/');
    if (candidate && !candidate.startsWith('../') && candidate !== '..' && !candidate.startsWith('/') && TRACE_FILE.test(candidate)) return candidate;
  }
  return undefined;
}

function safeTraceLocator(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const file = safeTraceFile(value.file);
  if (!file) return undefined;
  const line = value.line === undefined ? undefined : safeTraceInteger(value.line, 1_000_000);
  const column = value.column === undefined ? undefined : safeTraceInteger(value.column, 1_000_000);
  if (value.line !== undefined && line === undefined) return undefined;
  if (value.column !== undefined && column === undefined) return undefined;
  return { file, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}

function normalizeTraceIdentifier(state, value) {
  if ((typeof value !== 'string' && typeof value !== 'number') || (typeof value === 'string' && value.length > 512)) return undefined;
  if (typeof value === 'number' && !Number.isSafeInteger(value)) return undefined;
  const key = `${typeof value}:${String(value)}`;
  const existing = state.aliases.get(key);
  if (existing) return existing;
  const alias = `id#${state.nextAlias++}`;
  state.aliases.set(key, alias);
  return alias;
}

function normalizeTraceMap(state, value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!allowed.includes(key)) return undefined;
    const normalized = normalizeTraceIdentifier(state, entry);
    if (normalized === undefined) return undefined;
    result[key] = normalized;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

function normalizeTraceEvent(raw, sequence, state) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  if (Object.keys(raw).some(key => !TRACE_EVENT_KEYS.includes(key))) return undefined;
  if (raw.sequence !== undefined && safeTraceInteger(raw.sequence, 1_000_000) === undefined) return undefined;
  if (!TRACE_EVENT_KINDS.includes(raw.kind)) return undefined;
  if (raw.route !== undefined && raw.route !== 'O' && raw.route !== 'C') return undefined;
  const event = { sequence, kind: raw.kind };
  if (raw.route !== undefined) event.route = raw.route;
  for (const key of ['workflow', 'stage', 'phase', 'tool']) {
    if (raw[key] === undefined) continue;
    const value = safeTraceSemantic(raw[key]);
    if (value === undefined) return undefined;
    event[key] = value;
  }
  if (raw.identities !== undefined) {
    const identities = normalizeTraceMap(state, raw.identities, TRACE_IDENTITY_KEYS);
    if (identities === undefined) return undefined;
    event.identities = identities;
  }
  if (raw.links !== undefined) {
    const links = normalizeTraceMap(state, raw.links, TRACE_LINK_KEYS);
    if (links === undefined) return undefined;
    event.links = links;
  }
  if (raw.attempt !== undefined) {
    event.attempt = safeTraceInteger(raw.attempt, 1_000_000);
    if (event.attempt === undefined) return undefined;
  }
  if (raw.revision !== undefined) {
    if (typeof raw.revision === 'number') {
      event.revision = safeTraceInteger(raw.revision, 1_000_000_000);
      if (event.revision === undefined) return undefined;
    } else {
      event.revision = normalizeTraceIdentifier(state, raw.revision);
      if (event.revision === undefined) return undefined;
    }
  }
  if (raw.verdict !== undefined) {
    if (!TRACE_VERDICTS.includes(raw.verdict)) return undefined;
    event.verdict = raw.verdict;
  }
  if (raw.outcome !== undefined) {
    if (!TRACE_OUTCOMES.includes(raw.outcome)) return undefined;
    event.outcome = raw.outcome;
  }
  if (raw.count !== undefined) {
    event.count = safeTraceInteger(raw.count, 1_000_000_000);
    if (event.count === undefined) return undefined;
  }
  if (raw.faultPoint !== undefined) {
    if (!TRACE_FAULT_POINTS.includes(raw.faultPoint)) return undefined;
    event.faultPoint = raw.faultPoint;
  }
  if (raw.barrier !== undefined) {
    event.barrier = safeTraceSemantic(raw.barrier);
    if (event.barrier === undefined) return undefined;
  }
  if (raw.source !== undefined) {
    event.source = safeTraceLocator(raw.source);
    if (event.source === undefined) return undefined;
  }
  return event;
}

function parseScenarioTrace(message) {
  if (typeof message !== 'string' || !message.startsWith(SCENARIO_TRACE_PREFIX)) return undefined;
  let raw;
  try {
    raw = JSON.parse(message.slice(SCENARIO_TRACE_PREFIX.length));
  } catch {
    return undefined;
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !TRACE_ENVELOPE_KEYS.includes(key))) return undefined;
  if (raw.version !== 1 || !Array.isArray(raw.scenario_ids) || raw.scenario_ids.length === 0 || raw.scenario_ids.length > 64) return undefined;
  const scenarioIds = [];
  for (const value of raw.scenario_ids) {
    const id = safeTraceTag(value);
    if (!id || scenarioIds.includes(id)) return undefined;
    scenarioIds.push(id);
  }
  if (typeof raw.truncated !== 'boolean' || !Array.isArray(raw.events) || raw.events.length > 4096) return undefined;
  const source = raw.source === undefined ? undefined : safeTraceLocator(raw.source);
  if (raw.source !== undefined && source === undefined) return undefined;
  const state = { aliases: new Map(), nextAlias: 1 };
  const events = [];
  for (let index = 0; index < raw.events.length; index++) {
    const event = normalizeTraceEvent(raw.events[index], index + 1, state);
    if (event === undefined) return undefined;
    events.push(event);
  }
  return { scenario_ids: scenarioIds, source, truncated: raw.truncated, events };
}

function projectTrace(record, id) {
  const route = id[0];
  const routes = new Set(record.scenario_ids.map(value => value[0]));
  if (routes.size === 1) {
    if (record.events.some(event => event.route !== undefined && event.route !== route)) return { status: 'AMBIGUOUS', events: [] };
    return { status: 'PRESENT', events: record.events, record_index: record.trace_index, source: record.source, truncated: record.truncated };
  }
  if (record.events.some(event => event.route === undefined)) return { status: 'AMBIGUOUS', events: [] };
  const events = record.events.filter(event => event.route === route);
  if (events.length === 0) return { status: 'EMPTY', events: [], record_index: record.trace_index, source: record.source, truncated: record.truncated };
  return { status: 'PRESENT', events, record_index: record.trace_index, source: record.source, truncated: record.truncated };
}

function remapTraceEvent(event, recordIndex, state) {
  const remap = (values) => Object.fromEntries(Object.entries(values).map(([key, value]) => [key, normalizeTraceIdentifier(state, `${recordIndex}:${value}`)]));
  return {
    ...event,
    ...(event.identities ? { identities: remap(event.identities) } : {}),
    ...(event.links ? { links: remap(event.links) } : {}),
    ...(typeof event.revision === 'string' ? { revision: normalizeTraceIdentifier(state, `${recordIndex}:${event.revision}`) } : {}),
  };
}

function compareTraceRecords(left, right) {
  const leftSource = left.source;
  const rightSource = right.source;
  if (leftSource && !rightSource) return -1;
  if (!leftSource && rightSource) return 1;
  if (leftSource && rightSource) {
    for (const [leftValue, rightValue] of [[leftSource.file, rightSource.file], [leftSource.line ?? 0, rightSource.line ?? 0], [leftSource.column ?? 0, rightSource.column ?? 0]]) {
      if (leftValue === rightValue) continue;
      return leftValue < rightValue ? -1 : 1;
    }
  }
  const leftSemantic = JSON.stringify({ scenario_ids: left.scenario_ids, events: left.events });
  const rightSemantic = JSON.stringify({ scenario_ids: right.scenario_ids, events: right.events });
  return leftSemantic === rightSemantic ? 0 : leftSemantic < rightSemantic ? -1 : 1;
}

function traceForCase(records, id) {
  const matches = records.filter(record => record.scenario_ids.includes(id)).sort(compareTraceRecords);
  if (matches.length === 0) return { status: 'MISSING', events: [] };
  const sourceMissing = matches.some(record => !record.source);
  const projected = matches.map(record => projectTrace(record, id));
  if (projected.some(trace => trace.status === 'AMBIGUOUS')) return { status: 'AMBIGUOUS', events: [] };
  const events = projected.flatMap(trace => trace.events);
  const source = projected.find(trace => trace.source)?.source;
  if (events.length === 0) return { status: sourceMissing ? 'SOURCE_MISSING' : 'EMPTY', events: [], ...(source ? { source } : {}) };
  const truncated = projected.some(trace => trace.truncated);
  const aliases = { aliases: new Map(), nextAlias: 1 };
  const remapped = projected.flatMap(trace => trace.events.map(event => remapTraceEvent(event, trace.record_index ?? 0, aliases)));
  return {
    status: sourceMissing ? 'SOURCE_MISSING' : truncated ? 'TRUNCATED' : 'PRESENT',
    events: remapped.map((event, index) => ({ ...event, sequence: index + 1 })),
    ...(source ? { source } : {}),
  };
}

function traceFaultPoints(events) {
  return [...new Set(events.flatMap(event => event.faultPoint ? [event.faultPoint] : []))];
}

function evidenceLocator(value) {
  if (!value || typeof value !== 'object') return undefined;
  if (typeof value.file !== 'string' || value.file.includes('reliable-stage-trace')) return undefined;
  return safeTraceLocator(value);
}

function statusOutcome(previous, current) {
  if (previous === 'FAIL' || current === 'FAIL') return 'FAIL';
  if (previous === 'BLOCKED' || current === 'BLOCKED') return 'BLOCKED';
  return 'PASS';
}

// The same module serves as node:test's streaming reporter. Diagnostics are
// accepted only when they match the helper's validated, redacted trace schema.
export default async function* report(events) {
  const level = process.env.WORKFLOW_SCENARIO_LEVEL;
  const required = requiredCases(level);
  const results = new Map();
  const traces = [];
  let failures = 0;
  let tests = 0;
  let observedDuration;
  for await (const event of events) {
    if (event.type === 'test:diagnostic') {
      const trace = parseScenarioTrace(event.data?.message);
      if (trace) traces.push({ ...trace, trace_index: traces.length });
      continue;
    }
    if (event.type === 'test:summary') {
      if (typeof event.data?.duration_ms === 'number' && Number.isFinite(event.data.duration_ms) && event.data.duration_ms >= 0) observedDuration = event.data.duration_ms;
      continue;
    }
    if (!['test:pass', 'test:fail'].includes(event.type)) continue;
    const data = event.data;
    if (!data || data.details?.type === 'suite') {
      if (event.type === 'test:fail' && data?.details?.type === 'suite') failures++;
      continue;
    }
    tests++;
    const status = event.type === 'test:fail' ? 'FAIL' : data.skip || data.todo ? 'BLOCKED' : 'PASS';
    if (status !== 'PASS') failures++;
    const duration = typeof data.details?.duration_ms === 'number' && Number.isFinite(data.details.duration_ms) && data.details.duration_ms >= 0 ? data.details.duration_ms : 0;
    if (typeof data.name !== 'string') continue;
    for (const match of data.name.matchAll(/\[([OC]:(?:S\d{2}|R\d{2}|A\d{2}))\]/g)) {
      const id = match[1];
      if (!id) continue;
      const prior = results.get(id);
      process.stderr.write(`${JSON.stringify({ level, event: 'case_complete', id, status, duration_ms: duration })}\n`);
      const locator = evidenceLocator({ file: data.file, line: data.line, column: data.column });
      results.set(id, {
        id,
        test_outcome: statusOutcome(prior?.test_outcome, status),
        duration_ms: (prior?.duration_ms ?? 0) + duration,
        evidence: [...(prior?.evidence ?? []), ...(locator ? [{ ...locator, kind: 'test', status }] : [])],
      });
    }
  }
  const cases = [];
  let traceGaps = 0;
  for (const id of required) {
    const result = results.get(id);
    if (!result) {
      traceGaps++;
      cases.push({ id, scenario: id.slice(2), route: id[0], status: 'BLOCKED', outcome: 'BLOCKED', reason: 'missing_case', trace: { status: 'MISSING', events: [] }, evidence: [], assertions: [], source_evidence: [] });
      continue;
    }
    const trace = traceForCase(traces, id);
    if (trace.status !== 'PRESENT') traceGaps++;
    const outcome = result.test_outcome;
    const status = outcome === 'PASS' && trace.status !== 'PRESENT' ? 'BLOCKED' : outcome;
    const reason = status === 'BLOCKED' && outcome === 'PASS' ? `trace_${trace.status.toLowerCase()}` : undefined;
    const assertions = trace.source ? [{ ...trace.source, kind: 'assertion', status: outcome }] : [];
    const sourceEvidence = [...result.evidence, ...assertions];
    cases.push({
      id,
      scenario: id.slice(2),
      route: id[0],
      status,
      outcome,
      ...(reason ? { reason } : {}),
      duration_ms: result.duration_ms,
      evidence: sourceEvidence,
      assertions,
      source_evidence: sourceEvidence,
      trace: { status: trace.status, events: trace.events, fault_points: traceFaultPoints(trace.events), ...(trace.source ? { source: trace.source } : {}) },
      event_schedule: trace.events,
    });
  }
  const complete = failures === 0 && traceGaps === 0 && cases.every(item => item.status === 'PASS');
  const duration = observedDuration ?? [...results.values()].reduce((sum, item) => sum + item.duration_ms, 0);
  const targetMs = level === 'D' ? 60_000 : 180_000;
  const withinBudget = duration <= targetMs;
  const sourceSha256 = /^[a-f0-9]{64}$/i.test(process.env.WORKFLOW_SOURCE_SHA256 ?? '') ? process.env.WORKFLOW_SOURCE_SHA256 : undefined;
  yield `${JSON.stringify({ level, status: complete && withinBudget ? 'PASS' : 'FAIL', ...(sourceSha256 ? { source_sha256: sourceSha256 } : {}), tests, failures, trace_gaps: traceGaps, duration_ms: duration, target_ms: targetMs, within_budget: withinBudget, cases }, null, 2)}\n`;
  if (!complete || !withinBudget) process.exitCode = 1;
}

async function runWorker(level) {
  if (!Object.hasOwn(suites, level)) throw new Error('workflow scenarios: invalid worker level');
  const events = runTests({
    files: suites[level].map(file => join(root, file)),
    concurrency: level === 'D' ? 3 : 1,
    timeout: level === 'D' ? 60_000 : 180_000,
  });
  for await (const chunk of report(events)) process.stdout.write(chunk);
}

async function main() {
  const level = process.argv[2];
  if (!Object.hasOwn(suites, level)) throw new Error('Usage: node scripts/workflow-scenarios.mjs D|P');
  const files = suites[level].map(file => join(root, file));
  // Missing files are a failed acceptance prerequisite, never an empty PASS.
  await Promise.all(files.map(file => readFile(file)));
  const temporary = await mkdtemp(join(tmpdir(), 'workflow-scenarios-'));
  const targetMs = level === 'D' ? 60_000 : 180_000;
  const started = performance.now();
  const environment = scenarioEnvironment(temporary, level, (await sourceDigest()).digest('hex'));
  try {
    const child = spawn(process.execPath, [
      '--import', 'tsx', script, '--worker', level,
    ], { cwd: root, env: environment, stdio: 'inherit', detached: process.platform !== 'win32' });
    const stop = () => {
      try {
        if (process.platform === 'win32') {
          const killed = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
          if (killed.error) throw killed.error;
        }
        else process.kill(-child.pid, 'SIGKILL');
      } catch (error) {
        if (error.code !== 'ESRCH') throw error;
      }
    };
    const deadline = setTimeout(stop, targetMs * 3);
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
    let exit;
    try {
      exit = await new Promise((accept, reject) => {
        child.once('error', reject);
        child.once('exit', (code, signal) => accept({ code, signal }));
      });
    } finally {
      clearTimeout(deadline);
      process.removeListener('SIGINT', stop);
      process.removeListener('SIGTERM', stop);
      if (child.pid) stop();
    }
    const duration = Math.round(performance.now() - started);
    const withinBudget = duration <= targetMs;
    console.error(JSON.stringify({ level, duration_ms: duration, target_ms: targetMs, within_budget: withinBudget, exit }));
    process.exitCode = exit.code === 0 && !exit.signal && withinBudget ? 0 : 1;
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === script) {
  const execution = process.argv[2] === '--worker' ? runWorker(process.argv[3]) : main();
  execution.catch(error => {
    console.error(`workflow scenarios: ${error.code ?? error.message}`);
    process.exitCode = 1;
  });
}
