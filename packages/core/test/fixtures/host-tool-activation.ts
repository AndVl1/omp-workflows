import { afterEach as nodeTestAfterEach } from "node:test";
import { registerConstitutionTools, registerCtoTools, registerTeamWorkflow, registerWorkflowTools, type TeamSessionBindingController, type TeamSessionRuntimeBinding } from "../../src/index.js";
import { closeRegistryRegistrationContext } from "../../src/registry/owner.js";
import { revokeCtoRuntimeSessionAuthority } from "../../src/cto/session-authority.js";
import { TEST_CONTEXT } from "./registrar-host.js";
import {
  openTestRegistry,
  writeTestRegistryMarker,
  type TestRegistryRegistration,
} from "./registry-activation.js";

type RetainedTestTeamSession = {
  readonly controller: TeamSessionBindingController;
  readonly binding: TeamSessionRuntimeBinding;
};
const retainedTestTeamSessions = new Set<RetainedTestTeamSession>();

/** Release exact mounted test-session runtime capabilities before registry fixtures close. */
export function closeRetainedTestTeamSessions(): void {
  for (const session of [...retainedTestTeamSessions]) {
    if (!session.controller.release(session.binding)) {
      session.binding.runtimeAccess.close();
      revokeCtoRuntimeSessionAuthority(session.binding.runtimeAuthority);
      closeRegistryRegistrationContext(session.binding.registryContext);
    }
    retainedTestTeamSessions.delete(session);
  }
}

nodeTestAfterEach(() => closeRetainedTestTeamSessions());

export function registerTestWorkflowTools(
  root: string,
  pi: Parameters<typeof registerWorkflowTools>[0],
  options: Omit<NonNullable<Parameters<typeof registerWorkflowTools>[1]>, "cwd" | "owner" | "registrationToken"> = {},
  ownerId = "core-test-workflow-tools",
): void {
  writeTestRegistryMarker(root);
  const registration = openTestRegistry(root, ["workflow_tools"], ownerId);
  try {
    registerWorkflowTools(pi, { ...options, cwd: root, owner: () => registration.owner, registrationToken: registration.token });
    registration.retain(true);
  } catch (error) {
    try { registration.finish(false); } catch { /* preserve original */ }
    throw error;
  }
}

export function registerTestCtoTools(
  root: string,
  pi: Parameters<typeof registerCtoTools>[0],
  options: Omit<NonNullable<Parameters<typeof registerCtoTools>[1]>, "cwd" | "registrationToken"> = {},
  ownerId = "core-test-workflow-tools",
): void {
  writeTestRegistryMarker(root);
  const registration = openTestRegistry(root, ["workflow_tools"], ownerId, ["workflow_tools"]);
  try {
    registerCtoTools(pi, {
      ...options,
      cwd: options.resolveCwd === undefined ? root : undefined,
      owner: options.owner ?? (() => registration.owner),
      registrationToken: registration.token,
    });
    registration.retain(true);
  } catch (error) {
    try { registration.finish(false); } catch { /* preserve original */ }
    throw error;
  }
}

export function registerTestTeamWorkflow(
  root: string,
  pi: Parameters<typeof registerTeamWorkflow>[0],
  options: Omit<NonNullable<Parameters<typeof registerTeamWorkflow>[1]>, "cwd" | "owner" | "registrationToken" | "deferConstitutionGate"> = {},
  ownerId = "core-test-team-workflow",
): void {
  writeTestRegistryMarker(root);
  const registration = openTestRegistry(root, ["workflow_profiles", "constitution_gate", "runtime_config"], ownerId, ["workflow_registration", "config_writer"]);
  try {
    const installGate = registerTeamWorkflow(pi, {
      ...options,
      cwd: root,
      owner: () => registration.owner,
      registrationToken: registration.token,
      onSessionBindingController: (controller) => {
        const binding = controller.current(TEST_CONTEXT(root));
        if (binding) retainedTestTeamSessions.add({ controller, binding });
        options.onSessionBindingController?.(controller);
      },
    });
    if (installGate) installGate();
    registration.retain(true);
  } catch (error) {
    try { registration.finish(false); } catch { /* preserve original */ }
    throw error;
  }
}

export function registerTestConstitutionTools(
  root: string,
  pi: Parameters<typeof registerConstitutionTools>[0],
  options: Omit<NonNullable<Parameters<typeof registerConstitutionTools>[1]>, "cwd" | "owner" | "registrationToken"> = {},
  ownerId = "core-test-constitution-tools",
): void {
  writeTestRegistryMarker(root);
  const registration = openTestRegistry(root, ["workflow_tools"], ownerId);
  try {
    registerConstitutionTools(pi, { ...options, cwd: root, owner: () => registration.owner, registrationToken: registration.token });
    registration.retain(true);
  } catch (error) {
    try { registration.finish(false); } catch { /* preserve original */ }
    throw error;
  }
}

export type { TestRegistryRegistration };
