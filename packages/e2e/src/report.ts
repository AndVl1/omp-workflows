/**
 * Report generation — ux-e2e JSON + manual_qa-compatible markdown.
 *
 * `generateReport()` clamps step ratings against defect severity floors
 * (a CRITICAL defect caps the step at 1, HIGH at 2, MEDIUM at 3, LOW at 4)
 * and warns on every clamp, so the score can never outrun the defects.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';


/**
 * Strip ANSI escapes and lone C0 control chars from a value destined for
 * the report. Keeps \t \n \r at the byte level (they're harmless in JSON)
 * but drops the ESC (0x1b) sequence and embedded BEL/BS/VT/FF that
 * downstream renderers can mishandle. Mirrors `sanitizeForJson` in
 * server.ts — duplicated here so report.ts remains import-free.
 */
function sanitizeForJson(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/gu, '');
}
/* ------------------------------------------------------------------ */
/* Types                                                               */
/* ------------------------------------------------------------------ */

export type UxDimension =
  | 'message_clarity'
  | 'feedback_timing'
  | 'error_handling'
  | 'layout'
  | 'interactivity'
  | 'visual_rendering';

export type DefectSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW';

export type AgentDimension = 'task_fidelity' | 'communication' | 'tool_discipline' | 'output_quality' | 'recovery';

export type Verdict = 'PASS' | 'FAIL' | 'CONDITIONAL';

export type Recommendation = 'ship' | 'fix-high' | 'rework';

export const UX_DIMENSIONS: readonly UxDimension[] = [
  'message_clarity',
  'feedback_timing',
  'error_handling',
  'layout',
  'interactivity',
  'visual_rendering',
];

export const AGENT_DIMENSIONS: readonly AgentDimension[] = [
  'task_fidelity',
  'communication',
  'tool_discipline',
  'output_quality',
  'recovery',
];

export const DEFECT_SEVERITIES: readonly DefectSeverity[] = ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'];

/**
 * Defect floors: the highest rating a step may carry given its worst
 * attached defect. A step with no defects has no floor (5).
 */
export const DEFECT_FLOORS: Readonly<Record<DefectSeverity, number>> = {
  CRITICAL: 1,
  HIGH: 2,
  MEDIUM: 3,
  LOW: 4,
};

export interface UxDefect {
  readonly id: string;
  readonly severity: DefectSeverity;
  readonly dimension: UxDimension;
  readonly title: string;
  /** Step id the defect belongs to. */
  readonly step: string;
  readonly evidence: string[];
  readonly repro?: string;
  readonly notes?: string;
}

export interface UxStep {
  readonly id: string;
  readonly name: string;
  readonly order: number;
  readonly ratings: Partial<Record<UxDimension, number>>;
  /** Defect ids attached to this step. */
  readonly defects: string[];
  readonly screenshots: string[];
  readonly transcript_excerpt?: string;
  readonly notes?: string;
}

export interface AgentQuality {
  readonly rating: number;
  readonly rationale: string;
  readonly dimensions?: Partial<Record<AgentDimension, number>>;
}

export interface Overall {
  readonly score: number;
  readonly summary: string;
  readonly recommendation: Recommendation;
}

export interface ReportSessionMeta {
  readonly slug: string;
  readonly scratch_dir: string;
  readonly omp_version: string;
  readonly profile: string;
  readonly tty: { readonly cols: number; readonly rows: number; readonly term: string };
  readonly started_at: string | null;
  readonly finished_at: string | null;
  readonly task_prompt: string | null;
  readonly scenario: { readonly id: string; readonly title?: string } | null;
  readonly transcript: string;
  readonly session_jsonl: string;
  readonly events_jsonl: string;
  readonly omp_log: string;
}

export interface UxE2eReport {
  readonly type: 'ux-e2e';
  readonly schema_version: 1;
  readonly verdict: Verdict;
  readonly mode: 'ui';
  readonly regressions: string[];
  readonly session: ReportSessionMeta;
  readonly steps: UxStep[];
  readonly defects: UxDefect[];
  readonly agent_quality: AgentQuality;
  readonly overall: Overall;
  readonly evidence: string[];
  readonly generated_at: string;
}

export interface ReportInput {
  readonly steps: ReadonlyArray<Omit<UxStep, 'id'> & { readonly id?: string }>;
  readonly defects: ReadonlyArray<Omit<UxDefect, 'id'> & { readonly id?: string }>;
  readonly agent_quality: AgentQuality;
  readonly verdict: Verdict;
  readonly overall: { readonly summary: string; readonly recommendation?: Recommendation; readonly score?: number };
  readonly regressions?: readonly string[];
}

export interface GenerateReportOptions {
  /** Markdown output directory. Default `<cwd>/vibe-report`. */
  readonly mdDir?: string;
  /** Mirror evidence files to `<mdDir>/evidence/<slug>/`. */
  readonly copyEvidence?: boolean;
}

export interface GenerateReportResult {
  readonly jsonPath: string;
  readonly mdPath: string;
  readonly warnings: string[];
}

/* ------------------------------------------------------------------ */
/* Session metadata                                                    */
/* ------------------------------------------------------------------ */

interface RawSessionJson {
  readonly slug?: unknown;
  readonly url?: unknown;
  readonly token?: unknown;
  readonly wsPath?: unknown;
  readonly pid?: unknown;
  readonly started_at?: unknown;
  readonly omp_version?: unknown;
  readonly profile?: unknown;
  readonly tty?: unknown;
  readonly task_prompt?: unknown;
  readonly scenario?: unknown;
}

function readSessionMeta(scratchDir: string): RawSessionJson {
  const p = join(scratchDir, '.work-state', 'ux-e2e', 'session.json');
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as RawSessionJson;
  } catch {
    return {};
  }
}

/** Newest file matching `~/.omp/logs/omp.*.log`, or null. */
function newestOmpLog(): string | null {
  const dir = join(homedir(), '.omp', 'logs');
  if (!existsSync(dir)) return null;
  let best: string | null = null;
  let bestMtime = 0;
  for (const entry of readdirSync(dir)) {
    if (!entry.startsWith('omp.') || !entry.endsWith('.log')) continue;
    const p = join(dir, entry);
    try {
      const mtime = statSync(p).mtimeMs;
      if (mtime > bestMtime) {
        best = p;
        bestMtime = mtime;
      }
    } catch {
      /* skip unreadable entries */
    }
  }
  return best;
}

/* ------------------------------------------------------------------ */
/* Defect floors + clamping                                            */
/* ------------------------------------------------------------------ */

/** Effective rating for a dimension given the step's worst defect floor. */
function clampRating(rating: number | undefined, floor: number, warnings: string[], where: string): number | undefined {
  if (rating === undefined) return undefined;
  if (rating < 1) {
    warnings.push(`${where}: rating ${rating} clamped up to 1`);
    return 1;
  }
  if (rating > 5) {
    warnings.push(`${where}: rating ${rating} clamped down to 5`);
    return 5;
  }
  if (rating > floor) {
    warnings.push(`${where}: rating ${rating} clamped down to defect floor ${floor}`);
    return floor;
  }
  return rating;
}

function floorForStep(defects: readonly UxDefect[], stepId: string): number {
  let floor = 5;
  for (const d of defects) {
    if (d.step !== stepId) continue;
    const f = DEFECT_FLOORS[d.severity] ?? 5;
    if (f < floor) floor = f;
  }
  return floor;
}

/* ------------------------------------------------------------------ */
/* Evidence collection                                                 */
/* ------------------------------------------------------------------ */

function collectEvidence(
  scratchDir: string,
  screenshots: readonly string[],
): string[] {
  const stateDir = join(scratchDir, '.work-state', 'ux-e2e');
  const candidates: string[] = [
    join(stateDir, 'transcript.jsonl'),
    join(stateDir, 'session.json'),
    join(stateDir, 'session.jsonl'),
    join(stateDir, 'events.jsonl'),
    ...screenshots,
  ];
  const ompLog = newestOmpLog();
  if (ompLog !== null) candidates.push(ompLog);
  const evidence: string[] = [];
  for (const p of candidates) {
    if (p.length > 0 && existsSync(p)) evidence.push(resolve(p));
  }
  return [...new Set(evidence)];
}

function copyEvidence(evidence: readonly string[], targetDir: string): string[] {
  mkdirSync(targetDir, { recursive: true });
  const copied: string[] = [];
  for (const src of evidence) {
    try {
      const dst = join(targetDir, basename(src));
      copyFileSync(src, dst);
      copied.push(dst);
    } catch {
      copied.push(src); // keep the original reference when copy fails
    }
  }
  return copied;
}

/** Runtime-narrowed tty metadata from session.json (defaults when absent). */
function readTty(raw: unknown): { cols: number; rows: number; term: string } {
  if (typeof raw !== 'object' || raw === null) {
    return { cols: 100, rows: 30, term: 'xterm-256color' };
  }
  const cols = 'cols' in raw && typeof raw.cols === 'number' ? raw.cols : 100;
  const rows = 'rows' in raw && typeof raw.rows === 'number' ? raw.rows : 30;
  const term = 'term' in raw && typeof raw.term === 'string' && raw.term.length > 0 ? raw.term : 'xterm-256color';
  return { cols, rows, term };
}

/** Runtime-narrowed scenario reference from session.json (null when absent). */
function readScenarioRef(raw: unknown): { id: string; title?: string } | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const id = 'id' in raw && typeof raw.id === 'string' ? raw.id : 'unknown';
  const title = 'title' in raw && typeof raw.title === 'string' ? raw.title : undefined;
  return title !== undefined ? { id, title } : { id };
}

/* ------------------------------------------------------------------ */
/* Markdown                                                            */
/* ------------------------------------------------------------------ */

function formatTty(tty: ReportSessionMeta['tty']): string {
  return `${tty.cols}x${tty.rows} ${tty.term}`;
}

function renderMarkdown(report: UxE2eReport): string {
  const lines: string[] = [];
  lines.push(`# UX E2E Report — ${report.session.slug}`);
  lines.push('');
  lines.push(`**Verdict:** ${report.verdict}  `);
  lines.push(`**Overall:** ${report.overall.score.toFixed(1)}/5 — ${report.overall.recommendation}  `);
  lines.push(`**Generated:** ${report.generated_at}`);
  lines.push('');
  lines.push('## Session');
  lines.push('');
  lines.push(`- slug: \`${report.session.slug}\``);
  lines.push(`- scratch dir: \`${report.session.scratch_dir}\``);
  lines.push(`- omp version: \`${report.session.omp_version}\``);
  lines.push(`- profile: \`${report.session.profile}\``);
  lines.push(`- tty: \`${formatTty(report.session.tty)}\``);
  lines.push(`- started: \`${report.session.started_at ?? 'n/a'}\``);
  lines.push(`- finished: \`${report.session.finished_at ?? 'n/a'}\``);
  if (report.session.scenario !== null) {
    lines.push(`- scenario: \`${report.session.scenario.id}\`${report.session.scenario.title !== undefined ? ` — ${report.session.scenario.title}` : ''}`);
  }
  if (report.session.task_prompt !== null) {
    lines.push('');
    lines.push('### Task prompt');
    lines.push('');
    lines.push('```');
    lines.push(report.session.task_prompt.slice(0, 2000));
    lines.push('```');
  }
  lines.push('');
  lines.push('## Overall');
  lines.push('');
  lines.push(`**Score:** ${report.overall.score.toFixed(1)}/5  `);
  lines.push(`**Recommendation:** ${report.overall.recommendation}`);
  lines.push('');
  lines.push(report.overall.summary);
  lines.push('');
  if (report.regressions.length > 0) {
    lines.push('## Regressions');
    lines.push('');
    for (const r of report.regressions) lines.push(`- ${r}`);
    lines.push('');
  }
  lines.push('## Steps');
  lines.push('');
  lines.push('| # | Step | Rating | Defects |');
  lines.push('|---|------|--------|---------|');
  for (const step of report.steps) {
    const ratings = UX_DIMENSIONS.filter(d => step.ratings[d] !== undefined)
      .map(d => `${d}: ${String(step.ratings[d])}`)
      .join(', ');
    lines.push(`| ${step.order} | ${step.name} | ${ratings || 'n/a'} | ${step.defects.join(', ') || '—'} |`);
  }
  lines.push('');
  lines.push('## Defects');
  lines.push('');
  if (report.defects.length === 0) {
    lines.push('No defects recorded.');
  } else {
    for (const d of report.defects) {
      lines.push(`### ${d.id} [${d.severity}] ${d.title}`);
      lines.push('');
      lines.push(`- dimension: \`${d.dimension}\``);
      lines.push(`- step: \`${d.step}\``);
      if (d.repro !== undefined) lines.push(`- repro: \`${d.repro}\``);
      if (d.notes !== undefined) lines.push(`- notes: ${d.notes}`);
      if (d.evidence.length > 0) {
        lines.push('');
        lines.push('Evidence:');
        for (const e of d.evidence) lines.push(`  - \`${e}\``);
      }
      lines.push('');
    }
  }
  lines.push('## Agent quality');
  lines.push('');
  lines.push(`**Rating:** ${report.agent_quality.rating}/5  `);
  lines.push('');
  lines.push(report.agent_quality.rationale);
  if (report.agent_quality.dimensions !== undefined) {
    lines.push('');
    for (const dim of AGENT_DIMENSIONS) {
      const v = report.agent_quality.dimensions[dim];
      if (v !== undefined) lines.push(`- ${dim}: ${v}`);
    }
  }
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  for (const e of report.evidence) lines.push(`- \`${e}\``);
  lines.push('');
  return lines.join('\n');
}

/* ------------------------------------------------------------------ */
/* generateReport                                                      */
/* ------------------------------------------------------------------ */

function todayStamp(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Build the ux-e2e report from structured step/defect input, clamping
 * ratings against defect floors, and write both the JSON report and a
 * manual_qa-compatible markdown.
 *
 * @param sessionDir Scratch project directory (the `<scratch>` in the
 *                   contract — session.json lives under its `.work-state`).
 */
export function generateReport(
  sessionDir: string,
  input: ReportInput,
  opts: GenerateReportOptions = {},
): GenerateReportResult {
  const scratchDir = resolve(sessionDir);
  const warnings: string[] = [];
  const rawSession = readSessionMeta(scratchDir);
  const slug =
    typeof rawSession.slug === 'string' && rawSession.slug.length > 0
      ? rawSession.slug
      : basename(scratchDir).replace(/^omp-ux-e2e-/u, '') || 'ux-e2e';

  // Assign stable ids when the caller omitted them.
  const defects: UxDefect[] = input.defects.map((d, i) => ({
    ...d,
    id: d.id ?? `D${i + 1}`,
  }));
  const steps: UxStep[] = input.steps.map((s, i) => ({
    ...s,
    id: s.id ?? `S${i + 1}`,
  }));

  // Clamp step ratings against the worst defect floor per step.
  const clampedSteps: UxStep[] = steps.map(step => {
    const floor = floorForStep(defects, step.id);
    const ratings: Partial<Record<UxDimension, number>> = {};
    for (const dim of UX_DIMENSIONS) {
      const v = clampRating(step.ratings[dim], floor, warnings, `${step.id}.${dim}`);
      if (v !== undefined) ratings[dim] = v;
    }
    return { ...step, ratings };
  });

  // Overall score: caller's value, else the mean of all step ratings,
  // clamped by the worst defect floor in the whole run.
  const allRatings = clampedSteps.flatMap(s => UX_DIMENSIONS.map(d => s.ratings[d]).filter((v): v is number => v !== undefined));
  let score: number;
  if (input.overall.score !== undefined) {
    score = input.overall.score;
  } else if (allRatings.length > 0) {
    score = allRatings.reduce((a, b) => a + b, 0) / allRatings.length;
  } else {
    // No ratings supplied: neutral-good baseline (no defects -> no floor).
    score = 4;
  }
  const worstFloor = defects.reduce<number>((floor, d) => {
    const f = DEFECT_FLOORS[d.severity] ?? 5;
    return f < floor ? f : floor;
  }, 5);
  score = Math.min(Math.max(score, 1), 5);
  if (score > worstFloor) {
    warnings.push(`overall.score ${score.toFixed(2)} clamped down to defect floor ${worstFloor}`);
    score = worstFloor;
  }

  const recommendation: Recommendation =
    input.overall.recommendation ?? (score >= 4 ? 'ship' : score >= 3 ? 'fix-high' : 'rework');

  const agentRating = Math.min(Math.max(Math.round(input.agent_quality.rating), 0), 5);
  if (agentRating !== input.agent_quality.rating) {
    warnings.push(`agent_quality.rating ${String(input.agent_quality.rating)} clamped to ${agentRating}`);
  }

  const stateDir = join(scratchDir, '.work-state', 'ux-e2e');
  const transcript = join(stateDir, 'transcript.jsonl');
  const eventsJsonl = join(stateDir, 'events.jsonl');
  const sessionJsonl = join(stateDir, 'session.jsonl');

  const screenshots = clampedSteps.flatMap(s => s.screenshots);
  let evidence = collectEvidence(scratchDir, screenshots);
  if (opts.copyEvidence === true) {
    const mdRoot = resolve(opts.mdDir ?? join(process.cwd(), 'vibe-report'));
    evidence = copyEvidence(evidence, join(mdRoot, 'evidence', slug));
  }
  const report: UxE2eReport = {
    type: 'ux-e2e',
    schema_version: 1,
    verdict: input.verdict,
    mode: 'ui',
    regressions: [...(input.regressions ?? [])],
    session: {
      slug,
      scratch_dir: scratchDir,
      omp_version: typeof rawSession.omp_version === 'string' ? rawSession.omp_version : 'unknown',
      profile: typeof rawSession.profile === 'string' && rawSession.profile.length > 0 ? rawSession.profile : 'default',
      tty: readTty(rawSession.tty),
      started_at: typeof rawSession.started_at === 'string' ? rawSession.started_at : null,
      finished_at: null,
      task_prompt: typeof rawSession.task_prompt === 'string' ? sanitizeForJson(rawSession.task_prompt) : null,
      scenario: readScenarioRef(rawSession.scenario),
      transcript,
      session_jsonl: sessionJsonl,
      events_jsonl: eventsJsonl,
      omp_log: newestOmpLog() ?? '',
    },
    steps: clampedSteps,
    defects,
    agent_quality: { ...input.agent_quality, rating: agentRating },
    overall: { score, summary: input.overall.summary, recommendation },
    evidence,
    generated_at: new Date().toISOString(),
  };

  const jsonPath = join(stateDir, 'report.json');
  mkdirSync(stateDir, { recursive: true });
  const mdDir = resolve(opts.mdDir ?? join(process.cwd(), 'vibe-report'));
  mkdirSync(mdDir, { recursive: true });
  const mdPath = join(mdDir, `${slug}-ux-e2e-${todayStamp()}.md`);

  writeFileSync(jsonPath, JSON.stringify(report, null, 2) + '\n');
  writeFileSync(mdPath, renderMarkdown(report));

  return { jsonPath, mdPath, warnings };
}
