import { createHash, randomUUID } from "node:crypto";
import {
  controlPlaneValueEquals,
  validateLifecycleRequestValue,
  validatePrepareReplay,
  validateTrustedExecutionContextValue,
  type ControlPlaneIssue,
  type ControlPlaneValidation,
} from "./control-plane-contract.js";
import type {
  LifecycleErrorCode,
  LifecycleMode,
  LifecycleRequest,
  LifecycleSelector,
  NewLifecycleRequest,
  PrepareRequestReceipt,
  RunCandidate,
  RunSelectionSnapshot,
  TrustedExecutionContext,
} from "./types.js";

export interface LifecycleErrorOptions {
  run_id?: string;
  branch?: string;
  next_action?: string;
}

export class LifecycleError extends Error {
  readonly code: LifecycleErrorCode;
  readonly run_id?: string;
  readonly branch?: string;
  readonly next_action?: string;
  readonly unchanged = true as const;

  constructor(code: LifecycleErrorCode, message: string, options: LifecycleErrorOptions = {}) {
    super(message);
    this.name = "LifecycleError";
    this.code = code;
    this.run_id = options.run_id;
    this.branch = options.branch;
    this.next_action = options.next_action;
  }

  toJSON(): { code: LifecycleErrorCode; message: string; run_id?: string; branch?: string; unchanged: true; next_action?: string } {
    return {
      code: this.code,
      message: this.message,
      ...(this.run_id ? { run_id: this.run_id } : {}),
      ...(this.branch ? { branch: this.branch } : {}),
      unchanged: true,
      ...(this.next_action ? { next_action: this.next_action } : {}),
    };
  }
}

export type LifecycleIntentSource = "explicit" | "natural_language" | "default";
export interface LifecycleIntent {
  mode: LifecycleMode;
  source: LifecycleIntentSource;
  selector?: LifecycleSelector;
  feedback?: string;
}

function normalized(value: string): string {
  return value.trim().toLocaleLowerCase().replace(/\s+/g, " ");
}

/**
 * Natural lifecycle language is intentionally a command-shaped grammar. The
 * verb must lead the request (optionally after a registered command name), and
 * ordinary nouns such as "button" or an isolated bug report do not select an
 * existing run. A rework verb is accepted only with a result/workflow noun or
 * an explicit prior-run reference.
 */
const LIFECYCLE_INTENT_PATTERN = new RegExp(String.raw`^(?:\/(?:do-work|team)\s+)?((?:resume|continue|reconnect|attach)\s+(?:where\s+(?:we|i)\s+left\s+off|(?:(?:the|this|that)\s+)?(?:previous|prior|last|existing|unfinished|incomplete)\s+(?:work|task|feature|run|workflow|implementation|project)|(?:work|working)\s+on)|pick\s+up\s+where\s+(?:we|i)\s+left\s+off|(?:продолж(?:и|ить|ай|ать)|возобнов(?:и|ить|ай|ать))\s+\S+|вернись\s+к\s+(?:(?:этой|предыдущей|прошлой|текущей)\s+)?(?:фич\p{L}*|работ\p{L}*|задач\p{L}*|проект\p{L}*|запуск\p{L}*)|дальше\s+по\s+(?:этой\s+)?(?:фич\p{L}*|работ\p{L}*|задач\p{L}*|проект\p{L}*))|^(?:\/(?:do-work|team)\s+)?((?:rework|revise|amend)\s+(?:(?:(?:the|this|that)\s+)?(?:previous|prior|last|existing|earlier)\s+(?:work|task|feature|run|workflow|project|result|output|implementation)|(?:(?:the|this|that)\s+)?(?:result|output|implementation)|(?:result|output|implementation|work|task|feature|run|workflow|project)\s+(?:from|of|for)\s+(?:(?:the|this|that)\s+)?(?:previous|prior|last|existing|earlier))|(?:correct|fix|improve|repair|update)\s+(?:(?:the|this|that)\s+)?(?:previous|prior|last|existing|earlier)(?:\s+[\p{L}\p{N}_-]+){0,3}\s+(?:result|output|implementation|work|task|feature|run|workflow|project|bug|issue|defect|error)|(?:reopen|re-open)\s+(?:(?:the|this|that)\s+)?(?:previous|prior|last|existing|unfinished|incomplete)\s+(?:run|workflow|task|feature|work|implementation)|(?:доработ(?:ай|ать|и)|исправ(?:ь|ить|и)|поправ(?:ь|ить|и)|переоткрой|пересмотр(?:и|еть))\s+(?:(?:(?:эт(?:от|у|ого)|предыдущ(?:ий|ую|его)|прошл(?:ый|ую|ого)|существующ(?:ий|ую|его))\s+)(?:результат\p{L}*|вывод\p{L}*|реализац\p{L}*|работ\p{L}*|задач\p{L}*|фич\p{L}*|запуск\p{L}*|проект\p{L}*|баг\p{L}*|ошибк\p{L}*|дефект\p{L}*)|(?:результат\p{L}*|вывод\p{L}*|реализац\p{L}*)|(?:результат\p{L}*|вывод\p{L}*|реализац\p{L}*|работ\p{L}*|задач\p{L}*|фич\p{L}*|запуск\p{L}*|проект\p{L}*)\s+(?:предыдущ\p{L}*|прошл\p{L}*)))`, "iu");

/** Pure intent classification. Presence of history is intentionally ignored. */
export function resolveLifecycleIntent(input: {
  text?: string;
  mode?: LifecycleMode;
  selector?: LifecycleSelector;
  feedback?: string;
}): LifecycleIntent {
  if (input.mode) return { mode: input.mode, source: "explicit", ...(input.selector ? { selector: input.selector } : {}), ...(input.feedback ? { feedback: input.feedback } : {}) };
  const text = normalized(input.text ?? "");
  const match = LIFECYCLE_INTENT_PATTERN.exec(text);
  if (match?.[1]) {
    return { mode: "resume", source: "natural_language", ...(input.selector ? { selector: input.selector } : {}) };
  }
  if (match?.[2]) {
    return { mode: "rework", source: "natural_language", ...(input.selector ? { selector: input.selector } : {}), ...(input.feedback || text ? { feedback: input.feedback ?? input.text } : {}) };
  }
  return { mode: "new", source: "default" };
}

export interface RunSelectionInput {
  mode: "resume" | "rework";
  candidates: readonly RunCandidate[];
  currentBranch?: string;
  selector?: LifecycleSelector;
  sessionRunId?: string;
  snapshot?: RunSelectionSnapshot;
}

export type RunSelectionResult =
  | { ok: true; candidate: RunCandidate; selector: "explicit_id" | "explicit_title" | "list_item" | "session" | "branch_unique" }
  | { ok: false; error: LifecycleError; candidates: RunCandidate[]; snapshot?: RunSelectionSnapshot };

function eligible(candidate: RunCandidate, mode: "resume" | "rework"): boolean {
  return mode === "rework" || candidate.status !== "complete";
}

function selectionLabel(candidate: RunCandidate): string {
  return `${candidate.title} — ${candidate.branch} — ${candidate.status} — ${candidate.stage}`;
}

function selectionError(candidates: RunCandidate[], branch?: string): RunSelectionResult {
  const snapshot: RunSelectionSnapshot = {
    snapshot_id: randomUUID(),
    created_at: new Date().toISOString(),
    branch: branch ?? null,
    candidates: [...candidates],
  };
  const labels = candidates.map((candidate, index) => `${index + 1}. ${selectionLabel(candidate)} [${candidate.run_id}]`).join("; ");
  return {
    ok: false,
    candidates,
    snapshot,
    error: new LifecycleError("run_selection_required", `несколько запусков подходят; выберите пункт списка: ${labels}`, {
      branch,
      next_action: "повторить запрос с selector.list_item из показанного snapshot",
    }),
  };
}

/**
 * Resolve a user selector to exactly one candidate. Explicit selectors never
 * fall back to session or branch candidates; list numbers are tied to the
 * immutable snapshot supplied by the caller.
 */
export function selectRunCandidate(input: RunSelectionInput): RunSelectionResult {
  const all = input.candidates.filter((candidate) => eligible(candidate, input.mode));
  const selector = input.selector;
  if (selector?.run_id) {
    const known = input.candidates.find((entry) => entry.run_id === selector.run_id);
    if (known?.status === "complete" && input.mode === "resume") {
      return { ok: false, candidates: all, error: new LifecycleError("run_terminal", `run '${selector.run_id}' is terminal; use rework or new`, { run_id: selector.run_id, next_action: "use rework for feedback or start a new run" }) };
    }
    const candidate = all.find((entry) => entry.run_id === selector.run_id);
    if (!candidate) {
      return { ok: false, candidates: all, error: new LifecycleError("run_not_found", `run '${selector.run_id}' is not an eligible ${input.mode} target`, { run_id: selector.run_id, next_action: input.mode === "resume" ? "choose another unfinished run or use rework" : "list runs and choose a valid target" }) };
    }
    return { ok: true, candidate, selector: "explicit_id" };
  }
  if (selector?.title) {
    const title = normalized(selector.title);
    const matching = all.filter((entry) => normalized(entry.title) === title || normalized(entry.title).includes(title));
    if (matching.length === 1) return { ok: true, candidate: matching[0]!, selector: "explicit_title" };
    if (matching.length === 0) return { ok: false, candidates: all, error: new LifecycleError("run_not_found", `no ${input.mode} run matches explicit selector '${selector.title}'`, { branch: input.currentBranch, next_action: "list runs and choose an exact selector" }) };
    return selectionError(matching, input.currentBranch);
  }
  if (selector?.list_item) {
    if (!input.snapshot || input.snapshot.snapshot_id !== selector.list_item.snapshot_id) {
      return { ok: false, candidates: all, error: new LifecycleError("run_selection_required", "the displayed run list is stale; show it again before choosing a list item", { next_action: "request a fresh run list" }) };
    }
    if (input.currentBranch && input.snapshot.branch && input.snapshot.branch !== input.currentBranch) {
      return { ok: false, candidates: all, error: new LifecycleError("run_context_mismatch", `the displayed run list belongs to branch '${input.snapshot.branch}', current branch is '${input.currentBranch}'`, { branch: input.currentBranch, next_action: "request a fresh run list for the current branch" }) };
    }
    const listed = input.snapshot.candidates[selector.list_item.index];
    if (!listed || listed.run_id !== selector.list_item.run_id || (input.currentBranch && listed.branch !== input.currentBranch)) {
      return { ok: false, candidates: all, error: new LifecycleError("run_not_found", "the selected list item no longer identifies the same run", { run_id: selector.list_item.run_id, next_action: "request a fresh run list" }) };
    }
    const candidate = all.find((entry) => entry.run_id === listed.run_id);
    if (!candidate) return { ok: false, candidates: all, error: new LifecycleError("run_not_found", `selected run '${listed.run_id}' is no longer eligible`, { run_id: listed.run_id }) };
    return { ok: true, candidate, selector: "list_item" };
  }
  if (input.sessionRunId) {
    const candidate = all.find((entry) => entry.run_id === input.sessionRunId);
    if (candidate && (!input.currentBranch || candidate.branch === input.currentBranch)) return { ok: true, candidate, selector: "session" };
  }
  const branchCandidates = input.currentBranch ? all.filter((candidate) => candidate.branch === input.currentBranch) : all;
  if (branchCandidates.length === 1) return { ok: true, candidate: branchCandidates[0]!, selector: "branch_unique" };
  if (branchCandidates.length === 0) return { ok: false, candidates: all, error: new LifecycleError("run_not_found", `no eligible ${input.mode} run exists${input.currentBranch ? ` on branch '${input.currentBranch}'` : ""}`, { branch: input.currentBranch, next_action: "start a new run or choose another branch" }) };
  return selectionError(branchCandidates, input.currentBranch);
}

export function validateLifecycleRequest(request: unknown): ControlPlaneValidation {
  return validateLifecycleRequestValue(request);
}

export function validateTrustedExecutionContext(context: unknown): ControlPlaneValidation {
  return validateTrustedExecutionContextValue(context);
}

function canonicalize(input: unknown): unknown {
  if (Array.isArray(input)) return input.map(canonicalize);
  if (input && typeof input === "object") return Object.fromEntries(Object.entries(input as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, canonicalize(value)]));
  return input;
}

export function lifecyclePayloadHash(request: LifecycleRequest | Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(canonicalize(request))).digest("hex");
}

export function createLifecycleRequestId(): string {
  return randomUUID();
}

export function validateExactPrepareReplay(
  existing: Pick<PrepareRequestReceipt, "request_id" | "payload_hash">,
  request: LifecycleRequest | Record<string, unknown>,
): ControlPlaneValidation {
  return validatePrepareReplay(existing, { request_id: existing.request_id, payload_hash: lifecyclePayloadHash(request) });
}

export function assertValidLifecycleRequest(request: unknown): asserts request is LifecycleRequest {
  const result = validateLifecycleRequest(request);
  if (!result.ok) throw new LifecycleError("lifecycle_request_conflict", result.issues.map((issue: ControlPlaneIssue) => `${issue.path}: ${issue.message}`).join("; "), { next_action: "send an explicit schema-2 new/resume/rework request" });
}

export function assertTrustedExecutionContext(context: unknown): asserts context is TrustedExecutionContext {
  const result = validateTrustedExecutionContext(context);
  if (!result.ok) throw new LifecycleError("lifecycle_request_conflict", result.issues.map((issue: ControlPlaneIssue) => `${issue.path}: ${issue.message}`).join("; "));
}

/** New requests get a fresh id even when task text is byte-for-byte identical. */
export function newRequestForTask(input: Omit<NewLifecycleRequest, "mode" | "request_id">): NewLifecycleRequest {
  return { ...input, mode: "new", request_id: createLifecycleRequestId() };
}

export { controlPlaneValueEquals };
export type { LifecycleMode, LifecycleRequest, LifecycleSelector, PrepareRequestReceipt, RunCandidate, RunSelectionSnapshot, TrustedExecutionContext };
