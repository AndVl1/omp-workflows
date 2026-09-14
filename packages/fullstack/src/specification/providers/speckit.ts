/**
 * Optional existing-file constitution provider for Spec Kit projects (T065).
 *
 * Discovery-only provider over the canonical Spec Kit policy file
 * `.specify/memory/constitution.md`. "Existing-file": the provider reports
 * the candidate only when it is an existing, regular, project-local file —
 * it never generates, materializes, or rewrites Spec Kit content, and it
 * ships no template override (a missing Spec Kit constitution falls back to
 * the core native bootstrap template through the resolver's default).
 *
 * Discovery is local metadata inspection only: no CLI execution, no network,
 * no source writes. Symlinked or escaping paths fail closed to an empty
 * candidate set, so an unsafe Spec Kit tree can never outrank or poison the
 * native default resolution.
 *
 * Registration happens through the core seam
 * (`registerConstitutionProvider`) in the bundle wiring (T070); the core
 * resolver re-validates every discovered candidate (safe relative path,
 * existing regular file, realpath-bounded) before use, and multiple
 * resolving providers fail closed to SPEC_CONSTITUTION_SOURCE_AMBIGUOUS.
 */

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { join, sep } from "node:path";

import type { ConstitutionProvider } from "@andvl1/omp-workflows-core";

/** Provider id recorded in constitution selections resolved from Spec Kit. */
export const SPECKIT_CONSTITUTION_PROVIDER_ID = "speckit";

/** Canonical Spec Kit policy path, relative to the authorized project root. */
export const SPECKIT_CONSTITUTION_RELATIVE_PATH = ".specify/memory/constitution.md";

/**
 * Existing-file Spec Kit constitution provider: discovers
 * `.specify/memory/constitution.md` when it is an existing regular file
 * inside the project root; returns an empty candidate set otherwise
 * (including on unreadable roots — discovery must never throw).
 */
export const speckitConstitutionProvider: ConstitutionProvider = Object.freeze({
  provider_id: SPECKIT_CONSTITUTION_PROVIDER_ID,

  discover(projectRoot: string): string[] {
    try {
      const root = realpathSync(projectRoot);
      const absolute = join(root, SPECKIT_CONSTITUTION_RELATIVE_PATH);
      // Existence first so a missing Spec Kit tree stays a silent no-op.
      if (!existsSync(absolute)) return [];
      // lstat: a symlinked constitution (whatever its target) is never a
      // discovered candidate; policy files must be project-local originals.
      if (!lstatSync(absolute).isFile()) return [];
      const real = realpathSync(absolute);
      if (real !== root && !real.startsWith(root + sep)) return [];
      return [SPECKIT_CONSTITUTION_RELATIVE_PATH];
    } catch {
      // Fail closed to the native default; discovery never throws.
      return [];
    }
  },
});
