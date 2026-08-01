/**
 * Append-only event recorder.
 *
 * One file per feature: `<feature>/observability/events.jsonl`. The recorder
 * loads the existing rollup on each call, applies the new event, and
 * persists both. This is intentionally not a long-lived in-process cache —
 * OMP can spawn extensions per session, and the hook bus is per-extension,
 * so the recorder is re-entrant and stateless between calls.
 *
 * Storage strategy:
 *   - events.jsonl: line-delimited JSON, one event per line, append-only
 *   - rollup: in-memory only here; persisted via TeamState.observability
 *     by the engine's `writeState`. The recorder is the producer, the engine
 *     is the persister.
 *
 * Concurrency: appendFileSync is atomic for small writes (< PIPE_BUF on
 * POSIX). For multi-event hook bursts, we serialize via a single async
 * queue (no parallel writes). The recorder API is async to make the queue
 * contract explicit at the call site. Tests use `await recorder.flush()` to
 * drain the queue without real timers.
 */

import { existsSync, mkdirSync, readFileSync, appendFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
  emptyRollup,
  type ObservabilityEvent,
  type ObservabilityPointer,
  type ObservabilityRollup,
} from "./events.js";

const OBSERVABILITY_DIR = "observability";
const EVENTS_FILENAME = "events.jsonl";

export interface RecorderOptions {
  /** Cwd of the project. */
  cwd: string;
  /** Branch slug to scope the file under. */
  branch: string;
  /** Feature slug (under `.work-state/features/<slug>/`). */
  featureSlug?: string;
  /**
   * Optional id generator. Default: monotonic counter + Date.now base.
   * Tests inject a deterministic generator to keep ids stable.
   */
  nextId?: () => string;
}

let staticCounter = 0;

export class EventRecorder {
  private readonly cwd: string;
  private readonly branch: string;
  private readonly featureSlug: string;
  private readonly nextId: () => string;
  private readonly eventsPath: string;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: RecorderOptions) {
    this.cwd = opts.cwd;
    this.branch = opts.branch;
    this.featureSlug = opts.featureSlug ?? "default";
    this.nextId =
      opts.nextId ??
      ((): string => {
        const n = staticCounter++;
        return `evt-${Date.now().toString(36)}-${n.toString(36)}`;
      });
    this.eventsPath = this.resolveEventsPath();
  }

  /** Absolute path of the events.jsonl file. */
  get path(): string {
    return this.eventsPath;
  }

  /**
   * Wait for the in-memory write queue to drain. Tests use this instead of
   * real timers to assert post-write state without race conditions.
   */
  async flush(): Promise<void> {
    await this.queue;
  }

  /** Append a single event. Safe under concurrent calls. */
  append(event: Omit<ObservabilityEvent, "id" | "branch">): Promise<ObservabilityEvent> {
    const fullEvent: ObservabilityEvent = { ...event, id: this.nextId(), branch: this.branch };
    this.queue = this.queue.then(() => this.writeOne(fullEvent));
    return this.queue.then(() => fullEvent);
  }

  /** Read the full event log (small files expected; bounded by session length). */
  readAll(): ObservabilityEvent[] {
    if (!existsSync(this.eventsPath)) return [];
    const text = readFileSync(this.eventsPath, "utf8");
    const out: ObservabilityEvent[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        out.push(JSON.parse(trimmed) as ObservabilityEvent);
      } catch {
        // best-effort: skip corrupt lines rather than throw
      }
    }
    return out;
  }

  /**
   * Build the rollup by reading the full event log. Used on first append
   * if no prior rollup is supplied.
   */
  buildRollup(): ObservabilityRollup {
    return rollupFromEvents(this.readAll());
  }

  /**
   * Build an ObservabilityPointer (the shape `TeamState.observability` expects).
   * The rollup is computed from the event log + lastEventId = last id in log.
   */
  buildPointer(): ObservabilityPointer {
    const events = this.readAll();
    const last = events[events.length - 1];
    const rollup = rollupFromEvents(events);
    return {
      eventsPath: this.relativePath(),
      lastEventId: last?.id ?? "",
      rollupThroughId: last?.id ?? "",
      rollup,
    };
  }

  private resolveEventsPath(): string {
    const wsDir = resolve(this.cwd, ".work-state", "features", this.featureSlug);
    const obsDir = join(wsDir, OBSERVABILITY_DIR);
    mkdirSync(obsDir, { recursive: true });
    return join(obsDir, EVENTS_FILENAME);
  }

  private relativePath(): string {
    return join(OBSERVABILITY_DIR, EVENTS_FILENAME);
  }

  private async writeOne(event: ObservabilityEvent): Promise<void> {
    mkdirSync(dirname(this.eventsPath), { recursive: true });
    appendFileSync(this.eventsPath, JSON.stringify(event) + "\n", "utf8");
  }
}

/**
 * Pure rollup computation. Exported for callers (e.g. /pulse) that want to
 * re-aggregate without going through the recorder. Idempotent.
 */
export function rollupFromEvents(events: ReadonlyArray<ObservabilityEvent>): ObservabilityRollup {
  if (events.length === 0) {
    return emptyRollup(new Date(0).toISOString());
  }
  const first = events[0]!;
  const last = events[events.length - 1]!;
  const rollup: ObservabilityRollup = {
    ...emptyRollup(first.ts),
    firstEventAt: first.ts,
    lastEventAt: last.ts,
    agents: {},
    tools: {},
    toolErrors: {},
    subagents: {},
    skills: {},
  };
  for (const e of events) {
    if (e.kind === "agent_start") {
      rollup.agentInvocations += 1;
      const k = e.subagent ?? "__main__";
      rollup.agents[k] = (rollup.agents[k] ?? 0) + 1;
    }
    if (e.kind === "tool_call" && e.toolName) {
      rollup.totalToolCalls += 1;
      rollup.tools[e.toolName] = (rollup.tools[e.toolName] ?? 0) + 1;
      if (e.toolName === "task" && e.subagent) {
        rollup.subagents[e.subagent] = (rollup.subagents[e.subagent] ?? 0) + 1;
      }
    }
    if (e.kind === "tool_result" && e.toolName) {
      if (e.isError) {
        rollup.totalToolErrors += 1;
        rollup.toolErrors[e.toolName] = (rollup.toolErrors[e.toolName] ?? 0) + 1;
      }
    }
    if (e.skills && e.skills.length > 0) {
      for (const s of e.skills) {
        rollup.skills[s] = (rollup.skills[s] ?? 0) + 1;
      }
    }
  }
  const start = Date.parse(first.ts);
  const end = Date.parse(last.ts);
  rollup.durationMs = Number.isFinite(start) && Number.isFinite(end) && end >= start ? end - start : 0;
  return rollup;
}

/**
 * Best-effort: read a `TeamState.observability` pointer off disk and return
 * the events path + rollup. Returns null if the feature has no observability
 * dir yet (e.g. brand-new feature, or pre-observability state).
 */
export function readObservabilityPointer(
  cwd: string,
  featureSlug: string,
): ObservabilityPointer | null {
  const eventsPath = resolve(
    cwd,
    ".work-state",
    "features",
    featureSlug,
    OBSERVABILITY_DIR,
    EVENTS_FILENAME,
  );
  if (!existsSync(eventsPath)) return null;
  const text = readFileSync(eventsPath, "utf8");
  const events: ObservabilityEvent[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      events.push(JSON.parse(trimmed) as ObservabilityEvent);
    } catch {
      // skip
    }
  }
  const last = events[events.length - 1];
  return {
    eventsPath: join(OBSERVABILITY_DIR, EVENTS_FILENAME),
    lastEventId: last?.id ?? "",
    rollupThroughId: last?.id ?? "",
    rollup: rollupFromEvents(events),
  };
}

/** Write the pointer inside the feature's `state.json` (called by `writeState`). */
export function writePointerSync(
  cwd: string,
  featureSlug: string,
  pointer: ObservabilityPointer,
): void {
  // Mirror the events path into a small JSON file alongside the event log so
  // the engine can rebuild the pointer without re-reading state.json. The
  // canonical store is `TeamState.observability`; this file is the cache.
  const obsDir = resolve(
    cwd,
    ".work-state",
    "features",
    featureSlug,
    OBSERVABILITY_DIR,
  );
  mkdirSync(obsDir, { recursive: true });
  writeFileSync(join(obsDir, "pointer.json"), JSON.stringify(pointer, null, 2) + "\n", "utf8");
}
