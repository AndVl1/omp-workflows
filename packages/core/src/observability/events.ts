/**
 * Event types for runtime observability.
 *
 * The engine emits these on the OMP extension event bus
 * (`before_agent_start`, `agent_start`, `agent_end`, `tool_call`,
 * `tool_result`, `session_start`, `session_stop`). The recorder appends them
 * to `<feature>/observability/events.jsonl`; the rollup in `TeamState.observability`
 * is the cheap, read-once summary.
 *
 * Events are intentionally minimal. The recorder avoids carrying large
 * payloads (tool args, message arrays) — for those, the OMP session jsonl
 * remains the source of truth. Observability is for *who* ran, *how long*,
 * and *what skills were active*; not for the content of the work.
 */
export type EventKind =
  | "session_start"
  | "session_stop"
  | "before_agent_start"
  | "agent_start"
  | "agent_end"
  | "tool_call"
  | "tool_result";

/**
 * A single recorded event. `id` is a ULID-ish monotonic counter scoped to the
 * recorder instance (one recorder per `cwd`); we don't use uuid because the
 * call site can give a tight, ordered stream.
 */
export interface ObservabilityEvent {
  /** Monotonic id within a recorder instance (string for jsonl readability). */
  id: string;
  /** Event kind. */
  kind: EventKind;
  /** ISO-8601 timestamp from the OMP event, not Date.now() — keeps wall clock honest. */
  ts: string;
  /** Session id (from session_start / session_stop). */
  sessionId?: string;
  /** Branch resolved at session start (constant per recorder). */
  branch: string;
  /** OMP toolCallId for tool_call/tool_result events. */
  toolCallId?: string;
  /** Tool name for tool_call/tool_result events. */
  toolName?: string;
  /** True when the tool result reported an error. */
  isError?: boolean;
  /** For tool_call: the subagent agent name when the tool was `task`. */
  subagent?: string;
  /** For tool_call on `task`: the prompt size (chars) of the subagent's task body. */
  subagentTaskChars?: number;
  /** For agent_start: same fields the event already had; here for the recorder's symmetry. */
  agentStartMs?: number;
  /** For agent_end: how many messages the agent produced. */
  messageCount?: number;
  /** Skills detected from the system prompt during this turn. */
  skills?: string[];
}

/**
 * Cheap, read-once rollup over the event log. The recorder updates it
 * incrementally on each `append` and persists it in `TeamState.observability`.
 */
export interface ObservabilityRollup {
  /** Number of distinct agent_start events (== subagent spawns + main). */
  agentInvocations: number;
  /** Per-agent invocation count (key = agent name, or "__main__" / "task:<agent>"). */
  agents: Record<string, number>;
  /** Per-tool invocation count. */
  tools: Record<string, number>;
  /** Per-tool error count. */
  toolErrors: Record<string, number>;
  /** Subagent invocations broken down by agent (only for toolName="task"). */
  subagents: Record<string, number>;
  /** Skills observed during the run (deduplicated). */
  skills: Record<string, number>;
  /** Total tool_call events. */
  totalToolCalls: number;
  /** Total tool_result error events. */
  totalToolErrors: number;
  /** Wall-clock span from first to last event (ms). */
  durationMs: number;
  /** ISO timestamp of the first event in the current rollup. */
  firstEventAt: string;
  /** ISO timestamp of the last event in the current rollup. */
  lastEventAt: string;
}

/**
 * Pointer carried inside `TeamState`. Non-breaking: an absent `observability`
 * field means "this feature pre-dates observability" — readers should treat
 * that as "no telemetry available" rather than an error.
 */
export interface ObservabilityPointer {
  /** Path to the jsonl event log, relative to the feature dir. */
  eventsPath: string;
  /** Id of the last event written (or "" if no events yet). */
  lastEventId: string;
  /** Id of the first event in the rollup window (== lastEventId once rollup catches up). */
  rollupThroughId: string;
  /** Aggregate stats. */
  rollup: ObservabilityRollup;
}

export function emptyRollup(now: string): ObservabilityRollup {
  return {
    agentInvocations: 0,
    agents: {},
    tools: {},
    toolErrors: {},
    subagents: {},
    skills: {},
    totalToolCalls: 0,
    totalToolErrors: 0,
    durationMs: 0,
    firstEventAt: now,
    lastEventAt: now,
  };
}
