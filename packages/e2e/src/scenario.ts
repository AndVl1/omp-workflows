/**
 * Scenario definitions — the UX E2E "script" as DATA.
 *
 * A scenario is a JSON file (with an optional referenced task markdown)
 * describing the stages the tester should walk through, what to expect
 * at each stage, which [ask_user] prompts to answer, timing, screenshot
 * triggers, and the rating dimensions. New test surfaces = new scenario
 * files, zero code.
 *
 */

import { dirname, resolve, basename, sep } from 'node:path';
import { closePinnedDirectory, pinDirectory, readPinnedFileFull } from './fs-safety.js';

/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export interface AskExpectation {
  /** Optional regex matched against the [ask_user] title. */
  readonly titlePattern?: string;
  /** The answer to type into the terminal. */
  readonly answer: string;
  /** How many matching asks to answer this way. Default 1. */
  readonly count?: number;
}

export interface ScenarioStage {
  readonly id: string;
  readonly name: string;
  /** Regexes the transcript should match while in this stage. */
  readonly expect?: string[];
  /** When this regex matches the transcript, the stage is skipped. */
  readonly skip_if?: string;
  /** [ask_user] prompts expected in this stage. */
  readonly ask_user?: AskExpectation[];
}

export interface ScenarioTiming {
  readonly startupTimeoutMs: number;
  readonly stageTimeoutMs: number;
  readonly checkpointPollMs: number;
}

export type ScreenshotTrigger = 'stage_start' | 'stage_end' | 'ask_user' | 'error';

export interface ScenarioRatings {
  readonly dimensions: string[];
  readonly min: number;
  readonly max: number;
}

export type ScenarioTask = string | { readonly file: string };

/** Explicit identity used by a native run and every evidence lookup. */
export interface ScenarioSelectors {
  readonly feature_id: string;
  readonly run_key: string;
}

export interface CtoExecutionScenarioSetupSelector {
  readonly feature_id: string;
  readonly run_key: string;
}

export interface CtoExecutionScenarioSetup {
  readonly kind: 'cto-execution';
  readonly schema_version: 1;
  readonly selectors: readonly CtoExecutionScenarioSetupSelector[];
  readonly stale: {
    readonly feature_id: string;
    readonly run_key: string;
    readonly phase: 'plan';
    readonly version: 1;
    readonly expected_sha256: string;
    readonly actual_sha256: string;
    readonly reason: string;
  };
  readonly claimed: {
    readonly feature_id: string;
    readonly run_key: string;
    readonly owner_kind: 'do_work';
    readonly owner_run_id: string;
  };
}

/**
 * Canonical generated workspace locations. Paths are project-relative and
 * may contain templates (for example `specs/{{feature_id}}/spec.md`).
 */
export interface ScenarioWorkspacePaths {
  readonly path?: string;
  readonly state_path?: string;
  /** Readable phase/status documents generated below `specs/<feature-id>/`. */
  readonly documents?: string[];
  /** Phase and constitution-impact validation projections. */
  readonly validation?: string[];
  /** Archived readable revisions. */
  readonly history?: string[];
  /** Frozen implementation handoff projections. */
  readonly handoff?: string[];
  /** Durable checkpoint/answer ledgers used across interruption and resume. */
  readonly checkpoints?: string[];
  /** Additional scenario-specific evidence paths. */
  readonly evidence?: string[];
}

/**
 * Transcript assertions that are not tied to one terminal frame. Keeping
 * these declarations in the scenario makes checkpoint, worker, validation,
 * history, handoff, interruption, resume, and next-action evidence durable
 * without introducing another runner.
 */
export interface ScenarioTranscriptExpectations {
  readonly checkpoints?: string[];
  readonly workers?: string[];
  readonly validation?: string[];
  readonly history?: string[];
  readonly handoff?: string[];
  readonly interruption?: string[];
  readonly resume?: string[];
  readonly next_actions?: string[];
}

export interface ScenarioDefinition {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** Resolved task prompt (file references are read at load time). */
  readonly task: string;
  /** Declared params with defaults — merged into the expansion context. */
  readonly params: Record<string, string>;
  /** Explicit feature/run selectors, when the scenario declares them. */
  readonly selectors?: ScenarioSelectors;
  /** Optional strict setup executed before the OMP process starts. */
  readonly setup?: CtoExecutionScenarioSetup;
  /** Generated feature workspace paths and extra evidence paths. */
  readonly workspace?: ScenarioWorkspacePaths;
  /** Durable transcript markers expected by the scenario. */
  readonly transcript?: ScenarioTranscriptExpectations;
  readonly stages: ScenarioStage[];
  readonly timing: ScenarioTiming;
  readonly screenshots: { readonly on: ScreenshotTrigger[] };
  readonly ratings: ScenarioRatings;
}


/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

const VALID_SCREENSHOT_TRIGGERS: readonly string[] = ['stage_start', 'stage_end', 'ask_user', 'error'];

class ScenarioValidationError extends TypeError {
  constructor(field: string, problem: string) {
    super(`scenario: invalid "${field}" — ${problem}`);
    this.name = 'ScenarioValidationError';
  }
}

function requireString(value: unknown, field: string, problem: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) throw new ScenarioValidationError(field, problem);
}

const MAX_NODE_TIMER_MS = 2_147_483_647;

function requireTimerMs(value: unknown, field: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)
    || value <= 0 || value > MAX_NODE_TIMER_MS) {
    throw new ScenarioValidationError(field, `expected a positive safe integer <= ${String(MAX_NODE_TIMER_MS)}`);
  }
}

function requireNumber(value: unknown, field: string, problem: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ScenarioValidationError(field, problem);
}
function optionalString(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  requireString(value, field, 'expected a non-empty string');
  return value;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw new ScenarioValidationError(field, 'expected an array of non-empty strings');
  }
  return value as string[];
}

function optionalStringArray(value: unknown, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  return stringArray(value, field);
}

function validateScenario(raw: unknown): {
  def: Omit<ScenarioDefinition, 'task'> & { task: ScenarioTask };
} {
  if (typeof raw !== 'object' || raw === null) {
    throw new ScenarioValidationError('scenario', 'expected a JSON object');
  }
  const r = raw as Record<string, unknown>;

  requireString(r.id, 'id', 'expected a non-empty string');
  requireString(r.title, 'title', 'expected a non-empty string');
  if (r.description !== undefined) requireString(r.description, 'description', 'expected a string');

  let taskValue: ScenarioTask;
  const task = r.task;
  if (typeof task === 'string' && task.length > 0) {
    taskValue = task;
  } else if (typeof task === 'object' && task !== null && 'file' in task && typeof task.file === 'string' && task.file.length > 0) {
    taskValue = { file: task.file };
  } else {
    throw new ScenarioValidationError('task', 'expected a string or {file: string}');
  }

  if (!Array.isArray(r.stages) || r.stages.length === 0) {
    throw new ScenarioValidationError('stages', 'expected a non-empty array');
  }
  const stages: ScenarioStage[] = r.stages.map((stage, i) => {
    if (typeof stage !== 'object' || stage === null) {
      throw new ScenarioValidationError(`stages[${i}]`, 'expected an object');
    }
    const s = stage as Record<string, unknown>;
    requireString(s.id, `stages[${i}].id`, 'expected a non-empty string');
    requireString(s.name, `stages[${i}].name`, 'expected a non-empty string');
    if (s.expect !== undefined) {
      if (!Array.isArray(s.expect) || s.expect.some(e => typeof e !== 'string' || e.length === 0)) {
        throw new ScenarioValidationError(`stages[${i}].expect`, 'expected an array of non-empty strings');
      }
    }
    if (s.skip_if !== undefined) requireString(s.skip_if, `stages[${i}].skip_if`, 'expected a string');
    if (s.ask_user !== undefined) {
      if (!Array.isArray(s.ask_user)) {
        throw new ScenarioValidationError(`stages[${i}].ask_user`, 'expected an array');
      }
      s.ask_user.forEach((ask, j) => {
        if (typeof ask !== 'object' || ask === null) {
          throw new ScenarioValidationError(`stages[${i}].ask_user[${j}]`, 'expected an object');
        }
        const a = ask as Record<string, unknown>;
        requireString(a.answer, `stages[${i}].ask_user[${j}].answer`, 'expected a non-empty string');
        if (a.titlePattern !== undefined) {
          requireString(a.titlePattern, `stages[${i}].ask_user[${j}].titlePattern`, 'expected a string');
        }
        if (a.count !== undefined) {
          requireNumber(a.count, `stages[${i}].ask_user[${j}].count`, 'expected a number');
        }
      });
    }
    return {
      id: s.id as string,
      name: s.name as string,
      ...(s.expect !== undefined ? { expect: s.expect as string[] } : {}),
      ...(s.skip_if !== undefined ? { skip_if: s.skip_if as string } : {}),
      ...(s.ask_user !== undefined ? { ask_user: s.ask_user as AskExpectation[] } : {}),
    };
  });

  if (typeof r.timing !== 'object' || r.timing === null) {
    throw new ScenarioValidationError('timing', 'expected an object');
  }
  const timing = r.timing as Record<string, unknown>;
  requireTimerMs(timing.startupTimeoutMs, 'timing.startupTimeoutMs');
  requireTimerMs(timing.stageTimeoutMs, 'timing.stageTimeoutMs');
  requireTimerMs(timing.checkpointPollMs, 'timing.checkpointPollMs');

  if (typeof r.screenshots !== 'object' || r.screenshots === null) {
    throw new ScenarioValidationError('screenshots', 'expected an object');
  }
  const screenshots = r.screenshots as Record<string, unknown>;
  if (!Array.isArray(screenshots.on)) {
    throw new ScenarioValidationError('screenshots.on', 'expected an array');
  }
  for (const trigger of screenshots.on) {
    if (typeof trigger !== 'string' || !VALID_SCREENSHOT_TRIGGERS.includes(trigger)) {
      throw new ScenarioValidationError(
        'screenshots.on',
        `unexpected trigger ${JSON.stringify(trigger)}; expected one of ${VALID_SCREENSHOT_TRIGGERS.join(', ')}`,
      );
    }
  }

  if (typeof r.ratings !== 'object' || r.ratings === null) {
    throw new ScenarioValidationError('ratings', 'expected an object');
  }
  const ratings = r.ratings as Record<string, unknown>;
  if (!Array.isArray(ratings.dimensions) || ratings.dimensions.some(d => typeof d !== 'string' || d.length === 0)) {
    throw new ScenarioValidationError('ratings.dimensions', 'expected an array of non-empty strings');
  }
  requireNumber(ratings.min, 'ratings.min', 'expected a number');
  requireNumber(ratings.max, 'ratings.max', 'expected a number');
  if ((ratings.min as number) > (ratings.max as number)) {
    throw new ScenarioValidationError('ratings', `min (${String(ratings.min)}) must be <= max (${String(ratings.max)})`);
  }

  let params: Record<string, string> = {};
  if (r.params !== undefined) {
    if (typeof r.params !== 'object' || r.params === null) {
      throw new ScenarioValidationError('params', 'expected an object');
    }
    for (const [k, v] of Object.entries(r.params as Record<string, unknown>)) {
      if (typeof v !== 'string') throw new ScenarioValidationError(`params.${k}`, 'expected a string value');
    }
    params = r.params as Record<string, string>;
  }

  let setup: CtoExecutionScenarioSetup | undefined;
  if (r.setup !== undefined) {
    if (typeof r.setup !== 'object' || r.setup === null) {
      throw new ScenarioValidationError('setup', 'expected an object');
    }
    const setupValue = r.setup as Record<string, unknown>;
    const setupKeys = new Set(['kind', 'schema_version', 'selectors', 'stale', 'claimed']);
    for (const key of Object.keys(setupValue)) {
      if (!setupKeys.has(key)) throw new ScenarioValidationError(`setup.${key}`, 'unknown field');
    }
    if (setupValue.kind !== 'cto-execution') {
      throw new ScenarioValidationError('setup.kind', 'expected cto-execution');
    }
    if (setupValue.schema_version !== 1) {
      throw new ScenarioValidationError('setup.schema_version', 'expected version 1');
    }
    if (!Array.isArray(setupValue.selectors) || setupValue.selectors.length !== 4) {
      throw new ScenarioValidationError('setup.selectors', 'expected exactly four feature/run selectors');
    }
    const setupSelectors: CtoExecutionScenarioSetupSelector[] = setupValue.selectors.map((item, index) => {
      if (typeof item !== 'object' || item === null) {
        throw new ScenarioValidationError(`setup.selectors[${index}]`, 'expected an object');
      }
      const selector = item as Record<string, unknown>;
      for (const key of Object.keys(selector)) {
        if (key !== 'feature_id' && key !== 'run_key') throw new ScenarioValidationError(`setup.selectors[${index}].${key}`, 'unknown field');
      }
      const featureId = optionalString(selector.feature_id, `setup.selectors[${index}].feature_id`);
      const runKey = optionalString(selector.run_key, `setup.selectors[${index}].run_key`);
      if (featureId === undefined || runKey === undefined) {
        throw new ScenarioValidationError(`setup.selectors[${index}]`, 'feature_id and run_key are both required');
      }
      return { feature_id: featureId, run_key: runKey };
    });
    const staleValue = setupValue.stale;
    if (typeof staleValue !== 'object' || staleValue === null) throw new ScenarioValidationError('setup.stale', 'expected an object');
    const staleRecord = staleValue as Record<string, unknown>;
    for (const key of Object.keys(staleRecord)) {
      if (!new Set(['feature_id', 'run_key', 'phase', 'version', 'expected_sha256', 'actual_sha256', 'reason']).has(key)) throw new ScenarioValidationError(`setup.stale.${key}`, 'unknown field');
    }
    const staleFeatureId = optionalString(staleRecord.feature_id, 'setup.stale.feature_id');
    const staleRunKey = optionalString(staleRecord.run_key, 'setup.stale.run_key');
    const staleExpected = optionalString(staleRecord.expected_sha256, 'setup.stale.expected_sha256');
    const staleActual = optionalString(staleRecord.actual_sha256, 'setup.stale.actual_sha256');
    const staleReason = optionalString(staleRecord.reason, 'setup.stale.reason');
    if (!staleFeatureId || !staleRunKey || staleRecord.phase !== 'plan' || staleRecord.version !== 1 || !staleExpected || !staleActual || !staleReason) {
      throw new ScenarioValidationError('setup.stale', 'expected plan v1 with bounded revision hashes and reason');
    }
    const claimedValue = setupValue.claimed;
    if (typeof claimedValue !== 'object' || claimedValue === null) throw new ScenarioValidationError('setup.claimed', 'expected an object');
    const claimedRecord = claimedValue as Record<string, unknown>;
    for (const key of Object.keys(claimedRecord)) {
      if (!new Set(['feature_id', 'run_key', 'owner_kind', 'owner_run_id']).has(key)) throw new ScenarioValidationError(`setup.claimed.${key}`, 'unknown field');
    }
    const claimedFeatureId = optionalString(claimedRecord.feature_id, 'setup.claimed.feature_id');
    const claimedRunKey = optionalString(claimedRecord.run_key, 'setup.claimed.run_key');
    const ownerRunId = optionalString(claimedRecord.owner_run_id, 'setup.claimed.owner_run_id');
    if (!claimedFeatureId || !claimedRunKey || claimedRecord.owner_kind !== 'do_work' || !ownerRunId) {
      throw new ScenarioValidationError('setup.claimed', 'expected do_work owner and feature/run selector');
    }
    setup = {
      kind: 'cto-execution',
      schema_version: 1,
      selectors: setupSelectors,
      stale: { feature_id: staleFeatureId, run_key: staleRunKey, phase: 'plan', version: 1, expected_sha256: staleExpected, actual_sha256: staleActual, reason: staleReason },
      claimed: { feature_id: claimedFeatureId, run_key: claimedRunKey, owner_kind: 'do_work', owner_run_id: ownerRunId },
    };
  }

  let selectors: ScenarioSelectors | undefined;
  const selectorValue = r.selectors;
  if (selectorValue !== undefined) {
    if (typeof selectorValue !== 'object' || selectorValue === null) {
      throw new ScenarioValidationError('selectors', 'expected an object');
    }
    const s = selectorValue as Record<string, unknown>;
    const featureId = optionalString(s.feature_id ?? s.featureId, 'selectors.feature_id');
    const runKey = optionalString(s.run_key ?? s.runKey, 'selectors.run_key');
    if (featureId === undefined || runKey === undefined) {
      throw new ScenarioValidationError('selectors', 'feature_id and run_key are both required');
    }
    selectors = { feature_id: featureId, run_key: runKey };
  } else if (r.feature_id !== undefined || r.run_key !== undefined) {
    const featureId = optionalString(r.feature_id, 'feature_id');
    const runKey = optionalString(r.run_key, 'run_key');
    if (featureId === undefined || runKey === undefined) {
      throw new ScenarioValidationError('selectors', 'feature_id and run_key are both required');
    }
    selectors = { feature_id: featureId, run_key: runKey };
  }

  let workspace: ScenarioWorkspacePaths | undefined;
  const workspaceValue = r.workspace ?? r.workspace_paths;
  if (workspaceValue !== undefined) {
    if (typeof workspaceValue !== 'object' || workspaceValue === null) {
      throw new ScenarioValidationError('workspace', 'expected an object');
    }
    const w = workspaceValue as Record<string, unknown>;
    workspace = {
      ...(optionalString(w.path ?? w.workspace_path, 'workspace.path') !== undefined
        ? { path: optionalString(w.path ?? w.workspace_path, 'workspace.path') }
        : {}),
      ...(optionalString(w.state_path, 'workspace.state_path') !== undefined
        ? { state_path: optionalString(w.state_path, 'workspace.state_path') }
        : {}),
      ...(w.documents !== undefined ? { documents: stringArray(w.documents, 'workspace.documents') } : {}),
      ...(w.validation !== undefined ? { validation: stringArray(w.validation, 'workspace.validation') } : {}),
      ...(w.history !== undefined ? { history: stringArray(w.history, 'workspace.history') } : {}),
      ...(w.handoff !== undefined ? { handoff: stringArray(w.handoff, 'workspace.handoff') } : {}),
      ...(w.checkpoints !== undefined ? { checkpoints: stringArray(w.checkpoints, 'workspace.checkpoints') } : {}),
      ...(w.evidence !== undefined ? { evidence: stringArray(w.evidence, 'workspace.evidence') } : {}),
    };
  }

  let transcript: ScenarioTranscriptExpectations | undefined;
  const transcriptValue = r.transcript ?? r.transcript_expectations;
  if (transcriptValue !== undefined) {
    if (typeof transcriptValue !== 'object' || transcriptValue === null) {
      throw new ScenarioValidationError('transcript', 'expected an object');
    }
    const t = transcriptValue as Record<string, unknown>;
    transcript = {
      ...(optionalStringArray(t.checkpoints, 'transcript.checkpoints') !== undefined
        ? { checkpoints: optionalStringArray(t.checkpoints, 'transcript.checkpoints') }
        : {}),
      ...(optionalStringArray(t.workers, 'transcript.workers') !== undefined
        ? { workers: optionalStringArray(t.workers, 'transcript.workers') }
        : {}),
      ...(optionalStringArray(t.validation, 'transcript.validation') !== undefined
        ? { validation: optionalStringArray(t.validation, 'transcript.validation') }
        : {}),
      ...(optionalStringArray(t.history, 'transcript.history') !== undefined
        ? { history: optionalStringArray(t.history, 'transcript.history') }
        : {}),
      ...(optionalStringArray(t.handoff, 'transcript.handoff') !== undefined
        ? { handoff: optionalStringArray(t.handoff, 'transcript.handoff') }
        : {}),
      ...(optionalStringArray(t.interruption, 'transcript.interruption') !== undefined
        ? { interruption: optionalStringArray(t.interruption, 'transcript.interruption') }
        : {}),
      ...(optionalStringArray(t.resume, 'transcript.resume') !== undefined
        ? { resume: optionalStringArray(t.resume, 'transcript.resume') }
        : {}),
      ...(optionalStringArray(t.next_actions ?? t.nextActions, 'transcript.next_actions') !== undefined
        ? { next_actions: optionalStringArray(t.next_actions ?? t.nextActions, 'transcript.next_actions') }
        : {}),
    };
  }

  return {
    def: {
      id: r.id as string,
      title: r.title as string,
      ...(r.description !== undefined ? { description: r.description as string } : {}),
      task: taskValue,
      params,
      ...(selectors !== undefined ? { selectors } : {}),
      ...(setup !== undefined ? { setup } : {}),
      ...(workspace !== undefined ? { workspace } : {}),
      ...(transcript !== undefined ? { transcript } : {}),
      stages,
      timing: {
        startupTimeoutMs: timing.startupTimeoutMs as number,
        stageTimeoutMs: timing.stageTimeoutMs as number,
        checkpointPollMs: timing.checkpointPollMs as number,
      },
      screenshots: { on: screenshots.on as ScreenshotTrigger[] },
      ratings: {
        dimensions: ratings.dimensions as string[],
        min: ratings.min as number,
        max: ratings.max as number,
      },
    },
  };
}

/* ------------------------------------------------------------------ */
/* {{param}} expansion                                                 */
/* ------------------------------------------------------------------ */

const BUILTIN_DEFAULTS: Readonly<Record<string, string>> = {
  cols: '100',
  rows: '30',
  max_time: '30m',
  // Built-in defaults for the `full-feature` reference task template. These
  // let `loadScenario` produce a usable prompt out of the box (no literal
  // `{{...}}` left in the rendered text) and document the contract for
  // downstream scenarios that want to reuse the same template.
  feature_description: 'the feature described in the task prompt',
  project_name: 'ux-e2e-scratch',
  platform_scope: 'the requested surface (web / cli / mobile) as clarified by the user',
};

/** Replace `{{key}}` occurrences from `ctx`; unknown keys stay literal. */
export function expandTemplate(text: string, ctx: Readonly<Record<string, string>>): string {
  return text.replace(/\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/gu, (match, key: string) => {
    const value = ctx[key];
    return value !== undefined ? value : match;
  });
}

function expandValue(value: string, ctx: Readonly<Record<string, string>>): string {
  return expandTemplate(value, ctx);
}

function expandStage(stage: ScenarioStage, ctx: Readonly<Record<string, string>>): ScenarioStage {
  return {
    id: stage.id,
    name: expandValue(stage.name, ctx),
    ...(stage.expect !== undefined ? { expect: stage.expect.map(e => expandValue(e, ctx)) } : {}),
    ...(stage.skip_if !== undefined ? { skip_if: expandValue(stage.skip_if, ctx) } : {}),
    ...(stage.ask_user !== undefined
      ? {
          ask_user: stage.ask_user.map(a => ({
            ...(a.titlePattern !== undefined ? { titlePattern: expandValue(a.titlePattern, ctx) } : {}),
            answer: expandValue(a.answer, ctx),
            ...(a.count !== undefined ? { count: a.count } : {}),
          })),
        }
      : {}),
  };
}
function expandWorkspace(
  workspace: ScenarioWorkspacePaths | undefined,
  ctx: Readonly<Record<string, string>>,
  featureId: string | undefined,
): ScenarioWorkspacePaths | undefined {
  const generated =
    workspace === undefined && featureId !== undefined
      ? {
          path: `specs/${featureId}`,
          state_path: `.work-state/features/${featureId}/state.json`,
          documents: [
            `specs/${featureId}/status.md`,
            `specs/${featureId}/spec.md`,
            `specs/${featureId}/plan.md`,
            `specs/${featureId}/tasks.md`,
          ],
          validation: [
            `specs/${featureId}/validation/specify.md`,
            `specs/${featureId}/validation/plan.md`,
            `specs/${featureId}/validation/tasks.md`,
          ],
          history: [`specs/${featureId}/history`],
          handoff: [`specs/${featureId}/handoff.md`],
          checkpoints: [
            `.work-state/features/${featureId}/state.json`,
            `.work-state/ux-e2e/transcript.jsonl`,
            `.work-state/ux-e2e/ask-state.jsonl`,
          ],
        }
      : workspace;
  if (generated === undefined) return undefined;
  return {
    ...(generated.path !== undefined ? { path: expandValue(generated.path, ctx) } : {}),
    ...(generated.state_path !== undefined ? { state_path: expandValue(generated.state_path, ctx) } : {}),
    ...(generated.documents !== undefined ? { documents: generated.documents.map(value => expandValue(value, ctx)) } : {}),
    ...(generated.validation !== undefined ? { validation: generated.validation.map(value => expandValue(value, ctx)) } : {}),
    ...(generated.history !== undefined ? { history: generated.history.map(value => expandValue(value, ctx)) } : {}),
    ...(generated.handoff !== undefined ? { handoff: generated.handoff.map(value => expandValue(value, ctx)) } : {}),
    ...(generated.checkpoints !== undefined ? { checkpoints: generated.checkpoints.map(value => expandValue(value, ctx)) } : {}),
    ...(generated.evidence !== undefined ? { evidence: generated.evidence.map(value => expandValue(value, ctx)) } : {}),
  };
}

function expandTranscript(
  transcript: ScenarioTranscriptExpectations | undefined,
  ctx: Readonly<Record<string, string>>,
): ScenarioTranscriptExpectations | undefined {
  if (transcript === undefined) return undefined;
  const expand = (values: string[] | undefined): string[] | undefined =>
    values === undefined ? undefined : values.map(value => expandValue(value, ctx));
  return {
    ...(expand(transcript.checkpoints) !== undefined ? { checkpoints: expand(transcript.checkpoints) } : {}),
    ...(expand(transcript.workers) !== undefined ? { workers: expand(transcript.workers) } : {}),
    ...(expand(transcript.validation) !== undefined ? { validation: expand(transcript.validation) } : {}),
    ...(expand(transcript.history) !== undefined ? { history: expand(transcript.history) } : {}),
    ...(expand(transcript.handoff) !== undefined ? { handoff: expand(transcript.handoff) } : {}),
    ...(expand(transcript.interruption) !== undefined ? { interruption: expand(transcript.interruption) } : {}),
    ...(expand(transcript.resume) !== undefined ? { resume: expand(transcript.resume) } : {}),
    ...(expand(transcript.next_actions) !== undefined ? { next_actions: expand(transcript.next_actions) } : {}),
  };
}


function readBoundedScenarioFile(path: string, maxBytes: number): string {
  const absolute = resolve(path);
  const root = pinDirectory(dirname(absolute));
  if (root === null) throw new Error(`cannot open stable scenario parent: ${absolute}`);
  try {
    const bytes = readPinnedFileFull(root, basename(absolute), maxBytes);
    if (bytes === null) throw new Error(`cannot read bounded regular scenario file: ${absolute}`);
    return bytes.toString('utf8');
  } finally {
    closePinnedDirectory(root);
  }
}

/**
 * Load, validate, and expand a scenario file.
 *
 * @param path   Path to the scenario JSON.
 * @param params Runtime params merged over the scenario's declared
 *               defaults (e.g. `{slug, branch, cols, rows, max_time}`).
 *               `{{...}}` placeholders expand across the task text and
 *               every stage string.
 */
export function loadScenario(path: string, params: Record<string, string> = {}): ScenarioDefinition {
  let raw: unknown;
  try {
    raw = JSON.parse(readBoundedScenarioFile(path, 1024 * 1024));
  } catch (err) {
    throw new ScenarioValidationError('file', `cannot read/parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { def } = validateScenario(raw);

  // Selectors are part of the expansion context, so every generated path and
  // marker is bound to the same explicit feature/run pair.
  const ctx: Record<string, string> = {
    ...BUILTIN_DEFAULTS,
    ...def.params,
    ...(def.selectors !== undefined
      ? { feature_id: def.selectors.feature_id, run_key: def.selectors.run_key }
      : {}),
    ...params,
  };
  const featureId = ctx.feature_id;
  const runKey = ctx.run_key;
  const selectors =
    featureId !== undefined && runKey !== undefined
      ? { feature_id: featureId, run_key: runKey }
      : undefined;

  const expandedSetup = def.setup === undefined ? undefined : {
    ...def.setup,
    selectors: def.setup.selectors.map(selector => ({ feature_id: expandValue(selector.feature_id, ctx), run_key: expandValue(selector.run_key, ctx) })),
    stale: { ...def.setup.stale, feature_id: expandValue(def.setup.stale.feature_id, ctx), run_key: expandValue(def.setup.stale.run_key, ctx), expected_sha256: expandValue(def.setup.stale.expected_sha256, ctx), actual_sha256: expandValue(def.setup.stale.actual_sha256, ctx), reason: expandValue(def.setup.stale.reason, ctx) },
    claimed: { ...def.setup.claimed, feature_id: expandValue(def.setup.claimed.feature_id, ctx), run_key: expandValue(def.setup.claimed.run_key, ctx), owner_run_id: expandValue(def.setup.claimed.owner_run_id, ctx) },
  };

  let taskText: string;
  if (typeof def.task === 'string') {
    taskText = def.task;
  } else {
    const taskPath = resolve(dirname(path), expandValue(def.task.file, ctx));
    const scenarioDir = dirname(resolve(path));
    if (taskPath !== scenarioDir && !taskPath.startsWith(`${scenarioDir}${sep}`)) {
      throw new ScenarioValidationError('task.file', 'referenced task must remain contained by the scenario directory');
    }
    try {
      taskText = readBoundedScenarioFile(taskPath, 8 * 1024 * 1024);
    } catch (err) {
      throw new ScenarioValidationError('task.file', `cannot read referenced task file ${taskPath}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    id: def.id,
    title: expandValue(def.title, ctx),
    ...(def.description !== undefined ? { description: expandValue(def.description, ctx) } : {}),
    task: expandValue(taskText, ctx),
    params: def.params,
    ...(selectors !== undefined ? { selectors } : {}),
    ...(expandedSetup !== undefined ? { setup: expandedSetup } : {}),
    ...(def.workspace !== undefined || featureId !== undefined
      ? { workspace: expandWorkspace(def.workspace, ctx, featureId) }
      : {}),
    ...(def.transcript !== undefined ? { transcript: expandTranscript(def.transcript, ctx) } : {}),
    stages: def.stages.map(s => expandStage(s, ctx)),
    timing: def.timing,
    screenshots: def.screenshots,
    ratings: def.ratings,
  };
}
