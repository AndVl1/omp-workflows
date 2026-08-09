/**
 * Minimal slice-worker child-process fixture for the CTO process E2E
 * (packages/e2e/test/cto-process-e2e.test.ts).
 *
 * Deterministic resident simulation of ONE CTO slice team: writes a
 * done.json into its (already checked-out) git worktree, commits it, and
 * records the outcome in the shared evidence file. No network, no
 * credentials, no LLM — the only side effects are the worktree commit and
 * the evidence append.
 *
 * Usage: node --import tsx slice-worker.ts --worktree <path> --slice <id> --evidence <path>
 */

import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';

/** Identity on EVERY git command (the scratch repo has no user config). */
const GIT_IDENTITY = ['-c', 'user.name=Process E2E', '-c', 'user.email=process-e2e@example.invalid'];

function arg(name: string): string | null {
  const i = process.argv.indexOf(name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : null;
}

function record(entry: Record<string, unknown>, evidencePath: string): void {
  mkdirSync(dirname(evidencePath), { recursive: true });
  appendFileSync(evidencePath, `${JSON.stringify(entry)}\n`);
}

function git(cwd: string, args: string[]): { status: number; stdout: string; stderr: string } {
  const res = spawnSync('git', [...GIT_IDENTITY, ...args], { cwd, encoding: 'utf8' });
  return { status: res.status ?? -1, stdout: (res.stdout ?? '').trim(), stderr: (res.stderr ?? '').trim() };
}

async function main(): Promise<void> {
  const worktree = arg('--worktree');
  const slice = arg('--slice');
  const evidencePath = arg('--evidence');
  if (!worktree || !slice || !evidencePath) {
    throw new Error('usage: slice-worker.ts --worktree <path> --slice <id> --evidence <path>');
  }
  if (!existsSync(worktree)) throw new Error(`worktree missing: ${worktree}`);

  record({ t: 'worker-start', slice }, evidencePath);

  // Deterministic slice output: done.json committed in the worktree.
  writeFileSync(join(worktree, 'done.json'), `${JSON.stringify({ slice, at: new Date().toISOString() }, null, 2)}\n`);

  const add = git(worktree, ['add', '-A']);
  if (add.status !== 0) throw new Error(`git add failed in ${worktree}: ${add.stderr}`);
  const commit = git(worktree, ['commit', '-m', `slice ${slice} done`]);
  // "nothing to commit" is NOT a failure — the work is already committed
  // (a resumed wave whose done.json content is unchanged).
  if (commit.status !== 0 && !/nothing to commit/i.test(commit.stderr)) {
    throw new Error(`git commit failed in ${worktree}: ${commit.stderr}`);
  }
  const head = git(worktree, ['rev-parse', 'HEAD']);
  if (head.status !== 0) throw new Error(`git rev-parse failed in ${worktree}: ${head.stderr}`);
  const branch = git(worktree, ['branch', '--show-current']);
  if (branch.status !== 0) throw new Error(`git branch --show-current failed in ${worktree}: ${branch.stderr}`);

  record({ t: 'worker-done', slice, worktree, branch: branch.stdout, commit: head.stdout }, evidencePath);
}

main()
  .then(() => process.exit(0))
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // Best-effort failure record so the test can diagnose.
    try {
      const evidencePath = arg('--evidence');
      if (evidencePath) record({ t: 'worker-error', slice: arg('--slice'), error: message }, evidencePath);
    } catch {
      // evidence append is best-effort
    }
    process.stderr.write(`slice-worker failed: ${message}\n`);
    process.exit(1);
  });
