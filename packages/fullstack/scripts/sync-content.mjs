#!/usr/bin/env node
/**
 * sync-content.mjs — copy @omp-workflows/content/{agents,skills} into
 * packages/fullstack/{agents,skills} at publish time.
 *
 * Source of truth is packages/content/ (workspace-local, private). At publish
 * (npm pack or `npm publish`), npm does not follow external symlinks into a
 * sibling package, so we materialise the bundle into fullstack/ before pack
 * and restore it via `--restore` after.
 *
 * Invariants:
 *   - agents/ + skills/ inside this package's tarball = full snapshot from
 *     packages/content/. Never partially synced. Either fully copies or fully
 *     restores to empty.
 *   - This script NEVER touches packages/content/. One-way sync.
 *   - On `--restore`: leaves agents/ and skills/ empty directories so the
 *     package directory layout stays committed-friendly.
 */
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgRoot = path.resolve(__dirname, "..");
const repoRoot = path.resolve(pkgRoot, "..");
const contentRoot = path.join(repoRoot, "content");

const TARGETS = ["agents", "skills"];
const RESTORE = process.argv.includes("--restore");

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

async function rmrf(p) {
  await fs.rm(p, { recursive: true, force: true });
}

async function copyDir(src, dst) {
  await fs.mkdir(dst, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const e of entries) {
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) {
      await copyDir(s, d);
    } else if (e.isFile()) {
      await fs.copyFile(s, d);
    }
  }
}

async function ensureEmpty(name) {
  const dst = path.join(pkgRoot, name);
  await rmrf(dst);
  await fs.mkdir(dst, { recursive: true });
}

async function sync() {
  if (!await exists(contentRoot)) {
    throw new Error(`content source not found: ${contentRoot}`);
  }
  let totalFiles = 0;
  for (const name of TARGETS) {
    const src = path.join(contentRoot, name);
    const dst = path.join(pkgRoot, name);
    if (!await exists(src)) {
      throw new Error(`content/${name} not found: ${src}`);
    }
    await ensureEmpty(name);
    await copyDir(src, dst);
    const entries = await fs.readdir(dst);
    totalFiles += entries.length;
  }
  console.log(`sync-content: copied ${totalFiles} top-level entries from ${contentRoot}/ into ${pkgRoot}/`);
}

async function restore() {
  for (const name of TARGETS) {
    await ensureEmpty(name);
  }
  console.log(`sync-content --restore: cleared ${TARGETS.join(", ")} under ${pkgRoot}/`);
}

if (RESTORE) {
  await restore();
} else {
  await sync();
}
