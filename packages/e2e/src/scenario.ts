/**
 * Scenario definitions — the UX E2E "script" as DATA.
 *
 * A scenario is a JSON file (with an optional referenced task markdown)
 * describing the stages the tester should walk through, what to expect
 * at each stage, which [ask_user] prompts to answer, timing, screenshot
 * triggers, and the rating dimensions. New test surfaces = new scenario
 * files, zero code.
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';

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

export interface ScenarioDefinition {
  readonly id: string;
  readonly title: string;
  readonly description?: string;
  /** Resolved task prompt (file references are read at load time). */
  readonly task: string;
  /** Declared params with defaults — merged into the expansion context. */
  readonly params: Record<string, string>;
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

function requireNumber(value: unknown, field: string, problem: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new ScenarioValidationError(field, problem);
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
  requireNumber(timing.startupTimeoutMs, 'timing.startupTimeoutMs', 'expected a number');
  requireNumber(timing.stageTimeoutMs, 'timing.stageTimeoutMs', 'expected a number');
  requireNumber(timing.checkpointPollMs, 'timing.checkpointPollMs', 'expected a number');

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

  return {
    def: {
      id: r.id as string,
      title: r.title as string,
      ...(r.description !== undefined ? { description: r.description as string } : {}),
      task: taskValue,
      params,
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
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ScenarioValidationError('file', `cannot read/parse ${path}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const { def } = validateScenario(raw);

  let taskText: string;
  if (typeof def.task === 'string') {
    taskText = def.task;
  } else {
    const scenarioRoot = resolve(dirname(path));
    const taskPath = resolve(scenarioRoot, def.task.file);
    const taskRelative = relative(scenarioRoot, taskPath);
    if (taskRelative === '..' || taskRelative.startsWith(`..${sep}`) || taskRelative.length === 0) {
      throw new ScenarioValidationError('task.file', 'referenced task file must stay inside the scenario directory');
    }
    if (!existsSync(taskPath)) {
      throw new ScenarioValidationError('task.file', `referenced task file does not exist: ${taskPath}`);
    }
    taskText = readFileSync(taskPath, 'utf8');
  }

  const ctx: Record<string, string> = { ...BUILTIN_DEFAULTS, ...def.params, ...params };
  return {
    id: def.id,
    title: expandValue(def.title, ctx),
    ...(def.description !== undefined ? { description: expandValue(def.description, ctx) } : {}),
    task: expandValue(taskText, ctx),
    params: def.params,
    stages: def.stages.map(s => expandStage(s, ctx)),
    timing: def.timing,
    screenshots: def.screenshots,
    ratings: def.ratings,
  };
}
