import { basename, dirname, join, resolve, sep } from 'node:path';
import { closePinnedDirectory, pinOrCreateDirectory, writePinnedFile } from './fs-safety.js';

function writeFileAtomically(
  scratchDir: string,
  relativePath: string,
  content: string,
  _stagingPrefix: string,
): string {
  const root = resolve(scratchDir);
  const path = resolve(root, relativePath);
  if (path !== root && !path.startsWith(`${root}${sep}`)) {
    throw new Error(`ux-e2e: refusing to write outside scratch project: ${relativePath}`);
  }
  const parent = pinOrCreateDirectory(dirname(path));
  if (parent === null) throw new Error(`ux-e2e: refusing unsafe overlay parent: ${dirname(path)}`);
  try {
    if (!writePinnedFile(parent, basename(path), Buffer.from(content, 'utf8'))) {
      throw new Error(`ux-e2e: failed to publish overlay: ${relativePath}`);
    }
  } finally {
    closePinnedDirectory(parent);
  }
  return path;
}
/** Relative path passed to omp as the standard UX E2E config overlay. */
export const UX_E2E_OVERLAY_PATH = '.omp/ux-e2e-overlay.json';
const UX_E2E_OVERLAY = {
  ask: { timeout: 0 },
  terminal: { showProgress: true },
  autolearn: { enabled: false },
  startup: { setupWizard: false },
} as const;

/** Write a UTF-8 JSON document through the same scratch-local atomic path. */
export function writeJsonAtomically(
  scratchDir: string,
  relativePath: string,
  value: unknown,
  stagingPrefix: string,
): string {
  return writeFileAtomically(scratchDir, relativePath, `${JSON.stringify(value, null, 2)}\n`, stagingPrefix);
}

/**
 * Materialize the standard overlay in a scratch project and return its
 * absolute path. Rewriting on every start keeps the session contract
 * deterministic even when a scratch directory is reused.
 *
 * The temporary file lives in a unique sibling directory and is renamed into
 * place only after the complete JSON document has been written. omp therefore
 * never observes a partially-written overlay.
 */
export function writeUxE2eOverlay(scratchDir: string): string {
  return writeJsonAtomically(scratchDir, UX_E2E_OVERLAY_PATH, UX_E2E_OVERLAY, '.ux-e2e-overlay-');
}

