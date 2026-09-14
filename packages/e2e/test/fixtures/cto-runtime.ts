import { randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { openCtoRuntimeAccess, openCtoRuntimeProofAuthority, revokeCtoRuntimeProofAuthority, type CtoRuntimeAccessFacade, type CtoRuntimeProofAuthority } from '@andvl1/omp-workflows-core/cto-runtime';
import { PinnedProjectRoot } from '@andvl1/omp-workflows-core';
import type { RegistryContextSnapshot, RegistryRegistrationContext } from '@andvl1/omp-workflows-core/registry';
import { issueCtoRuntimeSessionAuthority, revokeCtoRuntimeSessionAuthority } from '../../../core/dist/cto/session-authority.js';

export interface E2eCtoRuntime {
  readonly access: CtoRuntimeAccessFacade;
  readonly proofAuthority: CtoRuntimeProofAuthority;
  readonly pinnedRoot: PinnedProjectRoot;
  readonly sessionId: string;
  readonly activationSnapshot: RegistryContextSnapshot;
  close(): void;
}

/** Open the opaque main-session and proof authorities used by CTO E2E fixtures. */
export function openE2eCtoRuntime(
  context: RegistryRegistrationContext,
  root: string,
  sessionId: string,
  activationSnapshot: () => RegistryContextSnapshot,
): E2eCtoRuntime {
  const pinnedRoot = PinnedProjectRoot.open(root);
  if (!pinnedRoot) throw new Error('CTO E2E project root could not be pinned');
  const sessionFile = join(root, '.omp', `session-${sessionId}.json`);
  mkdirSync(join(root, '.omp'), { recursive: true });
  writeFileSync(sessionFile, JSON.stringify({ sessionId, pid: process.pid }), { mode: 0o600 });
  const sessionBasename = sessionFile.split(/[\\/]/u).at(-1)!;
  const generation = `${process.pid}:${randomUUID()}`;
  const sessionManager = Object.freeze({
    getCwd: () => root,
    getSessionId: () => sessionId,
    getSessionFile: () => sessionFile,
    getSessionGeneration: () => generation,
  });
  const authority = issueCtoRuntimeSessionAuthority(
    context,
    { canonical_root: pinnedRoot.canonical_root, dev: pinnedRoot.dev, ino: pinnedRoot.ino },
    { sessionManager, sessionId, sessionFile, sessionBasename, generation },
    () => { activationSnapshot(); },
  );
  const opened = openCtoRuntimeAccess(context, authority, root);
  if (!opened.ok) {
    revokeCtoRuntimeSessionAuthority(authority);
    pinnedRoot.close();
    throw new Error(`${opened.code}: ${opened.error}`);
  }
  const proofAuthority = openCtoRuntimeProofAuthority(context, pinnedRoot);
  if (!proofAuthority) {
    opened.access.close();
    revokeCtoRuntimeSessionAuthority(authority);
    pinnedRoot.close();
    throw new Error('CTO E2E proof authority unavailable');
  }
  let closed = false;
  return {
    access: opened.access,
    proofAuthority,
    pinnedRoot,
    sessionId,
    activationSnapshot: activationSnapshot(),
    close(): void {
      if (closed) return;
      closed = true;
      revokeCtoRuntimeProofAuthority(proofAuthority);
      opened.access.close();
      revokeCtoRuntimeSessionAuthority(authority);
      pinnedRoot.close();
    },
  };
}
