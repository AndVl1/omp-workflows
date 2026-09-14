import { after as nodeTestAfter } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { registerWorkflowProfiles } from "../../src/engine/profile.js";
import { setConstitutionContinuationGate } from "../../src/engine/durable.js";
import { registerConstitutionProvider } from "../../src/specification/constitution-provider.js";
import { registerDocumentRenderer, registerFormatRecognizer, registerSpecificationRenderer } from "../../src/specification/registry.js";
import { registerArtifactRenderer, type ArtifactRenderer, type ArtifactRenderLayer } from "../../src/visualize/renderer-registry.js";
import { openCtoRuntimeAccess, registerCtoRuntimeAccessProvider, type CtoRuntimeAccessFacade } from "../../src/cto/runtime-access.js";
import { closeWorkflowActivation as closeDistWorkflowActivation, openWorkflowActivation as openDistWorkflowActivation, type WorkflowOwnerIdentity as DistWorkflowOwnerIdentity } from "../../src/registry/index.js";
import type { Profile } from "../../src/engine/types.js";
import type { ConstitutionProvider } from "../../src/specification/constitution-provider.js";
import type { DocumentRenderer } from "../../src/engine/types.js";
import type { FormatRecognizer, SpecificationRenderer } from "../../src/specification/registry.js";
import {
  beginRegistryRegistration,
  closeRegistryRegistrationContext,
  commitRegistryRegistration,
  openWorkflowActivation,
  releaseWorkflowOwners,
  rollbackRegistryRegistration,
  type RegistryFamily,
  type WorkflowCapability,
  type RegistryRegistrationToken,
  type WorkflowOwnerIdentity,
  type WorkflowOwnerReleaseToken,
  type RegistryRegistrationContext,
  type WorkflowActivationResult,
} from "../../src/registry/owner.js";

type WorkflowProfile = Profile;
type OpenedWorkflowActivation = Extract<WorkflowActivationResult, { readonly ok: true }>;
const MARKER_CONTENT = "omp-core-test-registry-marker-v1";

// Mounted host hooks resolve an existing run through the authenticated runtime
// provider registry. Keep isolated test facades discoverable by exact root and
// session, and remove each entry with its fixture's close operation.
const testRuntimeAccesses = new Map<string, CtoRuntimeAccessFacade>();
registerCtoRuntimeAccessProvider((canonicalRoot, sessionId) => testRuntimeAccesses.get(`${canonicalRoot}\0${sessionId}`) ?? null);

export function writeTestRegistryMarker(root: string): { path: string; sha256: string } {
  const path = join(root, ".omp-test-registry-marker");
  writeFileSync(path, MARKER_CONTENT);
  return { path: ".omp-test-registry-marker", sha256: createHash("sha256").update(MARKER_CONTENT).digest("hex") };
}

type RetainedRegistryRegistration = {
  readonly root: string;
  readonly rootDev: number;
  readonly rootIno: number;
  readonly context: RegistryRegistrationContext;
  readonly releaseToken: WorkflowOwnerReleaseToken;
  readonly leasedCapabilities: readonly WorkflowCapability[];
};
const retainedRegistryRegistrations = new Set<RetainedRegistryRegistration>();

function closeReplacedRetainedTestRegistrations(): void {
  for (const registration of [...retainedRegistryRegistrations]) {
    let current: { dev: number; ino: number } | undefined;
    try {
      if (existsSync(registration.root)) {
        const stat = statSync(registration.root);
        current = { dev: stat.dev, ino: stat.ino };
      }
    } catch {
      current = undefined;
    }
    if (current?.dev === registration.rootDev && current.ino === registration.rootIno) continue;
    closeRegistryRegistrationContext(registration.context);
    if (registration.leasedCapabilities.length > 0) releaseWorkflowOwners(registration.releaseToken, registration.leasedCapabilities);
    retainedRegistryRegistrations.delete(registration);
  }
}

/** Close all retained test activations at the owning node:test file teardown. */
export function closeRetainedTestRegistrations(root?: string): void {
  for (const registration of [...retainedRegistryRegistrations]) {
    if (root !== undefined && registration.root !== root) continue;
    closeRegistryRegistrationContext(registration.context);
    if (registration.leasedCapabilities.length > 0) releaseWorkflowOwners(registration.releaseToken, registration.leasedCapabilities);
    retainedRegistryRegistrations.delete(registration);
  }
}

nodeTestAfter(() => closeRetainedTestRegistrations());

/** Open a marker-authenticated RuntimeAccess for tests that create CTO runs. */
export function openTestCtoRuntime(
  root: string,
  sessionId = "main-session",
  ownerId = "core-cto-runtime-test",
): {
  readonly access: CtoRuntimeAccessFacade;
  readonly registryContext: OpenedWorkflowActivation["registry_context"];
  readonly owner: DistWorkflowOwnerIdentity;
  readonly close: () => void;
} {
  const marker = writeTestRegistryMarker(root);
  const owner: DistWorkflowOwnerIdentity = {
    owner_id: ownerId,
    bundle_id: ownerId,
    owner_kind: "private_omp",
    activation_marker: `${ownerId}-activation`,
    activation: { marker_id: `${ownerId}-activation`, required: [{ path: marker.path, kind: "file", sha256: marker.sha256 }] },
    host_range: ">=17.3 <19",
    provenance: { package: "@andvl1/omp-workflows-core", entrypoint: "test", cwd: root },
  };
  const activated = openDistWorkflowActivation(root, ["workflow_registration", "workflow_tools"], owner);
  if (!activated.ok) throw new Error(`${activated.code}: ${activated.error}`);
  const opened = openCtoRuntimeAccess(activated.registry_context, { sessionId, main: true }, root);
  if (!opened.ok) {
    closeDistWorkflowActivation(activated);
    throw new Error(`${opened.code}: ${opened.error}`);
  }
  const runtimeRoot = realpathSync(root);
  const runtimeKey = `${runtimeRoot}\0${sessionId}`;
  testRuntimeAccesses.set(runtimeKey, opened.access);
  let closed = false;
  return {
    access: opened.access,
    registryContext: activated.registry_context,
    owner,
    close: () => {
      if (closed) return;
      closed = true;
      testRuntimeAccesses.delete(runtimeKey);
      opened.access.close();
      closeDistWorkflowActivation(activated);
    },
  };
}

export interface TestRegistryRegistration {
  /** Marker-authenticated context retained for runtime capability fixtures. */
  readonly context: RegistryRegistrationContext;
  readonly token: RegistryRegistrationToken;
  readonly owner: WorkflowOwnerIdentity;
  readonly finish: (committed?: boolean) => void;
  /** Commit while retaining the marker-authenticated context until file teardown. */
  readonly retain: (committed?: boolean) => void;
}

/** Open one genuine marker-backed registry transaction for an isolated test root. */
export function openTestRegistry(root: string, families: readonly RegistryFamily[], ownerId = "core-test-registry", activationCapabilities?: readonly WorkflowCapability[]): TestRegistryRegistration {
  closeReplacedRetainedTestRegistrations();
  const markerPath = ".omp-test-registry-marker";
  const markerDigest = createHash("sha256").update(readFileSync(join(root, markerPath))).digest("hex");
  const owner: WorkflowOwnerIdentity = {
    owner_id: ownerId,
    bundle_id: ownerId,
    owner_kind: "private_omp",
    activation_marker: `${ownerId}-activation`,
    activation: { marker_id: `${ownerId}-activation`, required: [{ path: markerPath, kind: "file", sha256: markerDigest }] },
    host_range: ">=17.3 <19",
    provenance: { package: "@andvl1/omp-workflows-core", entrypoint: "test", cwd: root },
  };
  const mappedCapabilities = activationCapabilities ?? families.map((family): WorkflowCapability => family === "workflow_tools" ? "workflow_tools" : family === "runtime_config" ? "config_writer" : "workflow_registration");
  const capabilities = [...new Set<WorkflowCapability>(["workflow_registration", ...mappedCapabilities])];
  const activated = openWorkflowActivation(root, capabilities, owner);
  if (!activated.ok) throw new Error(`${activated.code}: ${activated.error}`);
  const transaction = beginRegistryRegistration(activated.registry_context, root, families);
  if (!transaction.ok) {
    closeRegistryRegistrationContext(activated.registry_context);
    if (activated.leased_capabilities.length > 0) releaseWorkflowOwners(activated.release_token, activated.leased_capabilities);
    throw new Error(`${transaction.code}: ${transaction.error}`);
  }
  const rootStat = statSync(root);
  let finished = false;
  const settle = (committed: boolean, retain: boolean): void => {
    if (finished) return;
    finished = true;
    try {
      if (committed) commitRegistryRegistration(transaction.token);
      else rollbackRegistryRegistration(transaction.token);
      if (committed && retain) {
        retainedRegistryRegistrations.add({
          root,
          rootDev: rootStat.dev,
          rootIno: rootStat.ino,
          context: activated.registry_context,
          releaseToken: activated.release_token,
          leasedCapabilities: activated.leased_capabilities,
        });
        return;
      }
    } catch (error) {
      try { rollbackRegistryRegistration(transaction.token); } catch { /* preserve original */ }
      throw error;
    } finally {
      if (!(committed && retain)) {
        closeRegistryRegistrationContext(activated.registry_context);
        if (activated.leased_capabilities.length > 0) releaseWorkflowOwners(activated.release_token, activated.leased_capabilities);
      }
    }
  };
  const finish = (committed = true): void => settle(committed, false);
  const retain = (committed = true): void => settle(committed, true);
  return { context: activated.registry_context, token: transaction.token, owner, finish, retain };
}

export function registerTestProfiles(root: string, profiles: readonly WorkflowProfile[], ownerId = "core-test-profile"): void {
  const registration = openTestRegistry(root, ["workflow_profiles"], ownerId);
  try { registerWorkflowProfiles(registration.token, profiles); registration.retain(true); } catch (error) { try { registration.finish(false); } catch { /* preserve original */ } throw error; }
}

export function registerTestConstitutionProvider(root: string, provider: ConstitutionProvider, ownerId = "core-test-constitution"): void {
  const registration = openTestRegistry(root, ["constitution_providers"], ownerId);
  try { registerConstitutionProvider(registration.token, provider); registration.retain(true); } catch (error) { try { registration.finish(false); } catch { /* preserve original */ } throw error; }
}

export function registerTestFormatRecognizer(root: string, recognizer: FormatRecognizer, ownerId = "core-test-recognizer"): void {
  const registration = openTestRegistry(root, ["format_recognizers"], ownerId);
  try { registerFormatRecognizer(registration.token, recognizer); registration.retain(true); } catch (error) { try { registration.finish(false); } catch { /* preserve original */ } throw error; }
}

export function registerTestDocumentRenderer(root: string, renderer: DocumentRenderer, ownerId = "core-test-document"): void {
  const registration = openTestRegistry(root, ["document_renderers"], ownerId);
  try { registerDocumentRenderer(registration.token, renderer); registration.retain(true); } catch (error) { try { registration.finish(false); } catch { /* preserve original */ } throw error; }
}

export function registerTestSpecificationRenderer(root: string, renderer: SpecificationRenderer, ownerId = "core-test-specification"): ReturnType<typeof registerSpecificationRenderer> {
  const registration = openTestRegistry(root, ["specification_renderers"], ownerId);
  try { const result = registerSpecificationRenderer(registration.token, renderer); registration.retain(true); return result; } catch (error) { try { registration.finish(false); } catch { /* preserve original */ } throw error; }
}

export function registerTestArtifactRenderer(root: string, layer: ArtifactRenderLayer, artifactId: string, renderer: ArtifactRenderer, ownerId = "core-test-visual"): void {
  const registration = openTestRegistry(root, ["visual_renderers"], ownerId);
  try { registerArtifactRenderer(registration.token, layer, artifactId, renderer); registration.retain(true); } catch (error) { try { registration.finish(false); } catch { /* preserve original */ } throw error; }
}

export function registerTestConstitutionGate(root: string, ownerId = "core-test-constitution-gate"): void {
  const registration = openTestRegistry(root, ["constitution_gate"], ownerId);
  try {
    setConstitutionContinuationGate(registration.token, () => null);
    registration.retain(true);
  } catch (error) {
    try { registration.finish(false); } catch { /* preserve original */ }
    throw error;
  }
}

export function withTestRegistry<T>(
  root: string,
  families: readonly RegistryFamily[],
  callback: (registration: TestRegistryRegistration) => T,
  ownerId = "core-test-registry",
): T {
  const registration = openTestRegistry(root, families, ownerId);
  try {
    const result = callback(registration);
    registration.finish(true);
    return result;
  } catch (error) {
    try { registration.finish(false); } catch { /* preserve the original test failure */ }
    throw error;
  }
}
