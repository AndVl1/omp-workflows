/**
 * Definition-of-Done lifecycle.
 *
 * - APPEND: add a new criterion owned by the current stage. Sets `source: <stageId>`,
 *   `id: <stageId>-<n>`, `status: "pending"`.
 * - CLOSE: flips an existing item to `met` ONLY with non-empty `evidence`.
 *
 * The `session_stop` gate (`dod-backstop.ts`) blocks a done-claim when items
 * are unmet or evidence-less.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { DoD, DoDItem } from "./types.js";

export function readDoD(artifactsDir: string): DoD | null {
  const path = join(artifactsDir, "dod.json");
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as DoD;
  } catch {
    return null;
  }
}

export function writeDoD(artifactsDir: string, dod: DoD): string {
  const path = join(artifactsDir, "dod.json");
  const stamped: DoD = { ...dod, updated_at: new Date().toISOString() };
  writeFileSync(path, JSON.stringify(stamped, null, 2) + "\n", "utf8");
  return path;
}

export function appendDoDItem(
  artifactsDir: string,
  stageId: string,
  criterion: string,
  verifyMethod: string,
  agent: string,
): DoD {
  const existing = readDoD(artifactsDir) ?? emptyDoD();
  const n = existing.items.filter((it) => it.source === stageId).length + 1;
  const item: DoDItem = {
    id: `${stageId}-${n}`,
    source: stageId,
    criterion,
    verify_method: verifyMethod,
    status: "pending",
    evidence: "",
  };
  const items = [...existing.items, item];
  const contributions = mergeContribution(existing.contributions, stageId, { added: [item.id], closed: [], by: agent });
  const next: DoD = { ...existing, items, contributions };
  writeDoD(artifactsDir, next);
  return next;
}

export function closeDoDItem(
  artifactsDir: string,
  itemId: string,
  evidence: string,
  agent: string,
): { ok: true; dod: DoD } | { ok: false; reason: string } {
  if (!evidence || !evidence.trim()) {
    return { ok: false, reason: "evidence is required to close a DoD item" };
  }
  const existing = readDoD(artifactsDir);
  if (!existing) return { ok: false, reason: "dod.json missing" };
  const items = existing.items.map((it) =>
    it.id === itemId ? { ...it, status: "met" as const, evidence: evidence.trim() } : it,
  );
  const item = existing.items.find((it) => it.id === itemId);
  if (!item) return { ok: false, reason: `DoD item ${itemId} not found` };
  const stageId = item.source;
  const contributions = mergeContribution(existing.contributions, stageId, { added: [], closed: [itemId], by: agent });
  const next: DoD = { ...existing, items, contributions };
  writeDoD(artifactsDir, next);
  return { ok: true, dod: next };
}

export function isDoDComplete(dod: DoD | null): { ok: true } | { ok: false; pending: DoDItem[] } {
  if (!dod) return { ok: false, pending: [] };
  const pending = dod.items.filter((it) => it.status !== "met" || !it.evidence);
  if (pending.length === 0) return { ok: true };
  return { ok: false, pending };
}

export function emptyDoD(): DoD {
  return { items: [], type_requirements_met: false, contributions: {}, updated_at: new Date().toISOString() };
}

function mergeContribution(
  existing: DoD["contributions"] | undefined,
  stageId: string,
  delta: { added: string[]; closed: string[]; by: string },
): DoD["contributions"] {
  const base = existing ?? {};
  const prev = base[stageId] ?? { added: [], closed: [], by: delta.by };
  return {
    ...base,
    [stageId]: {
      added: [...prev.added, ...delta.added],
      closed: [...prev.closed, ...delta.closed],
      by: delta.by,
    },
  };
}

/**
 * For BUG_FIX: gate BEFORE first code edit. The root_cause must be a non-empty
 * string in the diagnosis artifact and explain WHY the fix closes the cause.
 */
export function isRootCauseDocumented(
  artifactsDir: string,
): { ok: true; diagnosis: { root_cause: string; explanation: string } } | { ok: false; reason: string } {
  const path = join(artifactsDir, "diagnosis.json");
  if (!existsSync(path)) return { ok: false, reason: "diagnosis.json missing" };
  const diagnosis = JSON.parse(readFileSync(path, "utf8")) as { root_cause?: string; explanation?: string };
  if (!diagnosis.root_cause || !diagnosis.root_cause.trim()) {
    return { ok: false, reason: "diagnosis.root_cause is empty" };
  }
  if (!diagnosis.explanation || !diagnosis.explanation.trim()) {
    return { ok: false, reason: "diagnosis.explanation is empty (why does this fix close the root cause?)" };
  }
  return { ok: true, diagnosis: { root_cause: diagnosis.root_cause, explanation: diagnosis.explanation } };
}
