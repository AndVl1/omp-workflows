import { test as nodeTest, type TestContext as NodeTestContext, type TestOptions as NodeTestOptions } from "node:test";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { AsyncLocalStorage } from "node:async_hooks";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

/** The diagnostic prefix is intentionally not a general-purpose telemetry format. */
const SCENARIO_TRACE_PREFIX = "@@OMP_SCENARIO_TRACE@@";

export type TestContext = NodeTestContext;
export type TestOptions = NodeTestOptions;
export type ScenarioTestFunction = (context: TestContext) => void | Promise<void>;
type ScenarioDigit = "0" | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9";
export type ScenarioTag = `${"O" | "C"}:${"S" | "R" | "A"}${ScenarioDigit}${ScenarioDigit}`;
export type IdentityKey =
  | "run"
  | "stage"
  | "attempt"
  | "revision"
  | "worker"
  | "dispatch"
  | "checkpoint"
  | "barrier"
  | "task"
  | "receipt";
export type LinkKey =
  | IdentityKey
  | "parent"
  | "child"
  | "run_of"
  | "stage_of"
  | "attempt_of"
  | "revision_of"
  | "retry_of"
  | "checkpoint_of"
  | "dispatch_of"
  | "worker_of"
  | "cause"
  | "source"
  | "target";

const SCENARIO_EVENT_KINDS = [
  "workflow_registered",
  "workflow_started",
  "workflow_completed",
  "stage_registered",
  "stage_entered",
  "stage_exited",
  "stage_submitted",
  "tool_registered",
  "tool_called",
  "tool_completed",
  "worker_admitted",
  "worker_started",
  "worker_completed",
  "worker_failed",
  "attempt_started",
  "attempt_completed",
  "revision_created",
  "revision_published",
  "verdict_recorded",
  "count_recorded",
  "checkpoint_issued",
  "checkpoint_accepted",
  "checkpoint_rejected",
  "artifact_published",
  "fault_injected",
  "fault_observed",
  "barrier_wait",
  "barrier_released",
  "barrier_timeout",
  "recovery_diagnosed",
  "recovery_reconciled",
  "retry_started",
  "retry_completed",
  "run_completed",
] as const;
export type ScenarioEventKind = (typeof SCENARIO_EVENT_KINDS)[number];

const SCENARIO_VERDICTS = [
  "PASS",
  "FAIL",
  "BLOCKED",
  "RETRY",
  "PENDING",
  "ACCEPT",
  "REJECT",
  "UNKNOWN",
] as const;
export type ScenarioVerdict = (typeof SCENARIO_VERDICTS)[number];

const SCENARIO_OUTCOMES = [
  "PASS",
  "FAIL",
  "BLOCKED",
  "RETRY",
  "PENDING",
  "STARTED",
  "COMPLETED",
  "ACCEPTED",
  "REJECTED",
  "NOT_STARTED",
  "TIMEOUT",
  "CANCELLED",
  "UNKNOWN",
] as const;
export type ScenarioOutcome = (typeof SCENARIO_OUTCOMES)[number];

const SCENARIO_FAULT_POINTS = [
  "registration",
  "preflight",
  "admission",
  "validation",
  "execution",
  "submission",
  "publication",
  "checkpoint",
  "recovery",
  "barrier",
  "cleanup",
  "process",
  "transport",
  "race",
  "restart",
  "crash",
  "terminal",
  "identity",
  "ownership",
  "foreign",
  "replay",
  "corruption",
  "network",
  "unknown",
] as const;
export type ScenarioFaultPoint = (typeof SCENARIO_FAULT_POINTS)[number];

const IDENTITY_KEYS: Record<IdentityKey, true> = {
  run: true,
  stage: true,
  attempt: true,
  revision: true,
  worker: true,
  dispatch: true,
  checkpoint: true,
  barrier: true,
  task: true,
  receipt: true,
};
const LINK_KEYS: Record<LinkKey, true> = {
  run: true,
  stage: true,
  attempt: true,
  revision: true,
  worker: true,
  dispatch: true,
  checkpoint: true,
  barrier: true,
  task: true,
  receipt: true,
  parent: true,
  child: true,
  run_of: true,
  stage_of: true,
  attempt_of: true,
  revision_of: true,
  retry_of: true,
  checkpoint_of: true,
  dispatch_of: true,
  worker_of: true,
  cause: true,
  source: true,
  target: true,
};
const MAX_EVENTS = 4096;
const MAX_IDENTIFIER_LENGTH = 512;
const SAFE_SEMANTIC = /^[A-Za-z][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_FILE = /^[A-Za-z0-9_.@+-]+(?:\/[A-Za-z0-9_.@+-]+)*$/;

export type SourceLocator = Readonly<{
  file: string;
  line?: number;
  column?: number;
}>;

export type ScenarioEventInput = Readonly<{
  kind: ScenarioEventKind;
  route?: "O" | "C";
  workflow?: string;
  stage?: string;
  phase?: string;
  tool?: string;
  identities?: Partial<Record<IdentityKey, string | number>>;
  links?: Partial<Record<LinkKey, string | number>>;
  attempt?: number;
  revision?: number | string;
  verdict?: ScenarioVerdict;
  outcome?: ScenarioOutcome;
  count?: number;
  faultPoint?: ScenarioFaultPoint;
  barrier?: string;
  source?: SourceLocator;
}>;

export type ScenarioEvent = Readonly<{
  sequence: number;
  kind: ScenarioEventKind;
  route?: "O" | "C";
  workflow?: string;
  stage?: string;
  phase?: string;
  tool?: string;
  identities?: Readonly<Partial<Record<IdentityKey, string>>>;
  links?: Readonly<Partial<Record<LinkKey, string>>>;
  attempt?: number;
  revision?: number | string;
  verdict?: ScenarioVerdict;
  outcome?: ScenarioOutcome;
  count?: number;
  faultPoint?: ScenarioFaultPoint;
  barrier?: string;
  source?: SourceLocator;
}>;

type TraceStore = {
  readonly scenarios: readonly ScenarioTag[];
  readonly source?: SourceLocator;
  readonly events: ScenarioEvent[];
  readonly aliases: Map<string, string>;
  nextAlias: number;
  truncated: boolean;
};

const storage = new AsyncLocalStorage<TraceStore>();

function isScenarioTag(value: string): value is ScenarioTag {
  return /^(?:O|C):(?:S|R|A)\d{2}$/.test(value);
}

function safeSemantic(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_IDENTIFIER_LENGTH) return undefined;
  if (!SAFE_SEMANTIC.test(value) || /(?:token|secret|password|credential)/i.test(value) || /^[0-9a-f]{32,}$/i.test(value) || /^[0-9a-f]{8}-[0-9a-f-]{27,}$/i.test(value)) return undefined;
  return value;
}

function safeNumber(value: unknown, maximum: number): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= maximum ? value : undefined;
}

function safeSourceFile(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return undefined;
  const normalized = value.replaceAll("\\", "/");
  if (isAbsolute(normalized) || normalized.includes("..") || !SAFE_FILE.test(normalized)) return undefined;
  return normalized;
}

function safeSource(value: unknown): SourceLocator | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = value as { file?: unknown; line?: unknown; column?: unknown };
  const file = safeSourceFile(candidate.file);
  if (!file) return undefined;
  const line = candidate.line === undefined ? undefined : safeNumber(candidate.line, 1_000_000);
  const column = candidate.column === undefined ? undefined : safeNumber(candidate.column, 1_000_000);
  if (candidate.line !== undefined && line === undefined) return undefined;
  if (candidate.column !== undefined && column === undefined) return undefined;
  return { file, ...(line === undefined ? {} : { line }), ...(column === undefined ? {} : { column }) };
}

function aliasIdentity(store: TraceStore, value: string | number): string {
  const raw = String(value);
  const existing = store.aliases.get(raw);
  if (existing) return existing;
  const alias = `id#${store.nextAlias++}`;
  store.aliases.set(raw, alias);
  return alias;
}

function safeIdentityMap(
  store: TraceStore,
  input: unknown,
  allowed: Readonly<Record<string, true>>,
): Partial<Record<string, string>> | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const output: Partial<Record<string, string>> = {};
  for (const [key, value] of Object.entries(input)) {
    if (allowed[key] !== true) continue;
    if ((typeof value !== "string" && typeof value !== "number") || (typeof value === "string" && value.length > MAX_IDENTIFIER_LENGTH)) continue;
    if (typeof value === "number" && !Number.isSafeInteger(value)) continue;
    output[key] = aliasIdentity(store, value);
  }
  return Object.keys(output).length > 0 ? output : undefined;
}

function callerSource(): SourceLocator | undefined {
  const error = new Error();
  const stack = error.stack?.split("\n").slice(1) ?? [];
  for (const line of stack) {
    const match = line.match(/(?:\(|\s)((?:file:\/\/)?[^()\s]+):(\d+):(\d+)\)?$/);
    if (!match) continue;
    const [, rawFile, rawLine, rawColumn] = match;
    if (!rawFile || rawFile.startsWith("node:") || rawFile.includes("reliable-stage-trace")) continue;
    let file = rawFile;
    if (file.startsWith("file://")) {
      try {
        file = fileURLToPath(file);
      } catch {
        continue;
      }
    }
    const absolute = resolve(file);
    const root = repositoryRoot;
    const relativeFile = absolute === root ? "" : relative(root, absolute).replaceAll("\\", "/");
    if (!relativeFile || relativeFile.startsWith("../") || relativeFile === ".." || isAbsolute(relativeFile)) continue;
    const safeFile = safeSourceFile(relativeFile);
    const lineNumber = Number(rawLine);
    const columnNumber = Number(rawColumn);
    if (!safeFile || !Number.isSafeInteger(lineNumber) || !Number.isSafeInteger(columnNumber)) continue;
    return { file: safeFile, line: lineNumber, column: columnNumber };
  }
  return undefined;
}

function normalizeScenarioName(name: string): readonly ScenarioTag[] {
  const tags: ScenarioTag[] = [];
  for (const match of name.matchAll(/\[((?:O|C):(?:S|R|A)\d{2})\]/g)) {
    const tag = match[1];
    if (!tag || !isScenarioTag(tag) || tags.includes(tag)) continue;
    tags.push(tag);
  }
  return tags;
}

function safeEvent(store: TraceStore, input: ScenarioEventInput): ScenarioEvent | undefined {
  if (!input || typeof input !== "object" || !SCENARIO_EVENT_KINDS.includes(input.kind)) return undefined;
  if (input.route !== undefined && input.route !== "O" && input.route !== "C") return undefined;
  const event: {
    sequence: number;
    kind: ScenarioEventKind;
    route?: "O" | "C";
    workflow?: string;
    stage?: string;
    phase?: string;
    tool?: string;
    identities?: Readonly<Partial<Record<IdentityKey, string>>>;
    links?: Readonly<Partial<Record<LinkKey, string>>>;
    attempt?: number;
    revision?: number | string;
    verdict?: ScenarioVerdict;
    outcome?: ScenarioOutcome;
    count?: number;
    faultPoint?: ScenarioFaultPoint;
    barrier?: string;
    source?: SourceLocator;
  } = { sequence: store.events.length + 1, kind: input.kind };
  if (input.route !== undefined) event.route = input.route;
  for (const key of ["workflow", "stage", "phase", "tool"] as const) {
    if (input[key] === undefined) continue;
    const value = safeSemantic(input[key]);
    if (value !== undefined) event[key] = value;
  }
  const identities = safeIdentityMap(store, input.identities, IDENTITY_KEYS);
  const links = safeIdentityMap(store, input.links, LINK_KEYS);
  if (identities) event.identities = identities as Readonly<Partial<Record<IdentityKey, string>>>;
  if (links) event.links = links as Readonly<Partial<Record<LinkKey, string>>>;
  if (input.attempt !== undefined) {
    const attempt = safeNumber(input.attempt, 1_000_000);
    if (attempt !== undefined) event.attempt = attempt;
  }
  if (input.revision !== undefined) {
    if (typeof input.revision === "number") {
      if (Number.isSafeInteger(input.revision) && input.revision >= 0) event.revision = input.revision;
    } else if (typeof input.revision === "string" && input.revision.length <= MAX_IDENTIFIER_LENGTH) {
      event.revision = aliasIdentity(store, input.revision);
    }
  }
  if (input.verdict !== undefined && SCENARIO_VERDICTS.includes(input.verdict)) event.verdict = input.verdict;
  if (input.outcome !== undefined && SCENARIO_OUTCOMES.includes(input.outcome)) event.outcome = input.outcome;
  if (input.count !== undefined) {
    const count = safeNumber(input.count, 1_000_000_000);
    if (count !== undefined) event.count = count;
  }
  if (input.faultPoint !== undefined && SCENARIO_FAULT_POINTS.includes(input.faultPoint)) event.faultPoint = input.faultPoint;
  if (input.barrier !== undefined) {
    const barrier = safeSemantic(input.barrier);
    if (barrier !== undefined) event.barrier = barrier;
  }
  const source = safeSource(input.source);
  if (source) event.source = source;
  return event;
}

/** Record one validated semantic boundary while the enclosing scenario is active. */
export function recordScenarioEvent(input: ScenarioEventInput): void {
  const store = storage.getStore();
  if (!store) return;
  if (store.events.length >= MAX_EVENTS) {
    store.truncated = true;
    return;
  }
  const event = safeEvent(store, input);
  if (event) store.events.push(event);
}

/**
 * Register a node:test test while retaining the caller's source locator and a
 * safe, ordered semantic trace. The overloads intentionally mirror node:test:
 * (name, fn) and (name, options, fn).
 */
export function scenarioTest(name: string, fn: ScenarioTestFunction): Promise<void>;
export function scenarioTest(name: string, options: TestOptions, fn: ScenarioTestFunction): Promise<void>;
export function scenarioTest(name: string, optionsOrFn: TestOptions | ScenarioTestFunction, maybeFn?: ScenarioTestFunction): Promise<void> {
  const options = typeof optionsOrFn === "function" ? undefined : optionsOrFn;
  const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
  if (!fn) throw new TypeError("scenarioTest requires a test function");
  const scenarios = normalizeScenarioName(name);
  if (scenarios.length === 0) return options === undefined ? nodeTest(name, fn) : nodeTest(name, options, fn);
  const source = callerSource();
  const wrapped = async (context: TestContext): Promise<void> => {
    const store: TraceStore = { scenarios, ...(source ? { source } : {}), events: [], aliases: new Map(), nextAlias: 1, truncated: false };
    return storage.run(store, async () => {
      try {
        await fn(context);
      } finally {
        const envelope = {
          version: 1,
          scenario_ids: store.scenarios,
          ...(store.source ? { source: store.source } : {}),
          truncated: store.truncated,
          events: store.events,
        };
        context.diagnostic(`${SCENARIO_TRACE_PREFIX}${JSON.stringify(envelope)}`);
      }
    });
  };
  return options === undefined ? nodeTest(name, wrapped) : nodeTest(name, options, wrapped);
}
