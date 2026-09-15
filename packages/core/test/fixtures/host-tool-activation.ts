import { afterEach as nodeTestAfterEach } from "node:test";
import { existsSync } from "node:fs";
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
  readonly bindings: Map<string, TeamSessionRuntimeBinding>;
};
const retainedTestTeamSessions = new Set<RetainedTestTeamSession>();
const retainedBindingIdentities = new WeakMap<object, number>();
let nextRetainedBindingIdentity = 0;

function retainedBindingKey(binding: TeamSessionRuntimeBinding): string {
  const authority = binding.runtimeAuthority;
  const authorityObject = authority as object;
  let identity = retainedBindingIdentities.get(authorityObject);
  if (identity === undefined) {
    identity = ++nextRetainedBindingIdentity;
    retainedBindingIdentities.set(authorityObject, identity);
  }
  const generation = binding.generation === undefined ? "" : `${typeof binding.generation}:${String(binding.generation)}`;
  return `${identity}\0${binding.sessionId}\0${generation}`;
}

function retainBinding(
  controller: TeamSessionBindingController,
  binding: TeamSessionRuntimeBinding | null,
): void {
  if (!binding) return;
  const retained = [...retainedTestTeamSessions].find((candidate) => candidate.controller === controller);
  if (retained) {
    retained.bindings.set(retainedBindingKey(binding), binding);
    return;
  }
  retainedTestTeamSessions.add({
    controller,
    bindings: new Map([[retainedBindingKey(binding), binding]]),
  });
}

function safeCaptureBinding(
  root: string,
  controller: TeamSessionBindingController | undefined,
  context: unknown,
): void {
  if (!controller || !existsSync(root)) return;
  try {
    const binding = controller.current(context) ?? controller.current(TEST_CONTEXT(root));
    retainBinding(controller, binding);
  } catch {
    // The session handler's result/throw semantics must not change because
    // fixture evidence capture is best-effort after the handler has run.
  }
}

function interceptSessionStart(
  pi: Parameters<typeof registerTeamWorkflow>[0],
  capture: (context: unknown) => void,
): Parameters<typeof registerTeamWorkflow>[0] {
  const target = pi as object;
  return new Proxy(target, {
    get(current, property, receiver) {
      if (property !== "on") return Reflect.get(current, property, receiver);
      const original = Reflect.get(current, property, receiver);
      if (typeof original !== "function") return original;
      return (event: unknown, handler: unknown, ...rest: unknown[]) => {
        if (event !== "session_start" || typeof handler !== "function") {
          return Reflect.apply(original, receiver, [event, handler, ...rest]);
        }
        const wrappedHandler = function (this: unknown, ...args: unknown[]): unknown {
          const context = args[1];
          let result: unknown;
          try {
            result = Reflect.apply(handler, this, args);
          } catch (error) {
            capture(context);
            throw error;
          }
          if (result !== null && (typeof result === "object" || typeof result === "function")) {
            let then: unknown;
            try {
              then = (result as { then?: unknown }).then;
            } catch (error) {
              capture(context);
              throw error;
            }
            if (typeof then === "function") {
              return Promise.resolve(result).then(
                (value) => {
                  capture(context);
                  return value;
                },
                (error) => {
                  capture(context);
                  throw error;
                },
              );
            }
          }
          capture(context);
          return result;
        };
        return Reflect.apply(original, receiver, [event, wrappedHandler, ...rest]);
      };
    },
  }) as Parameters<typeof registerTeamWorkflow>[0];
}

/** Release exact mounted test-session runtime capabilities before registry fixtures close. */
export function closeRetainedTestTeamSessions(): void {
  for (const session of [...retainedTestTeamSessions]) {
    for (const binding of [...session.bindings.values()].reverse()) {
      if (!session.controller.release(binding)) {
        binding.runtimeAccess.close();
        revokeCtoRuntimeSessionAuthority(binding.runtimeAuthority);
        closeRegistryRegistrationContext(binding.registryContext);
      }
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
  options: Omit<NonNullable<Parameters<typeof registerCtoTools>[1]>, "cwd" | "owner" | "registrationToken"> = {},
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
  let controller: TeamSessionBindingController | undefined;
  try {
    const interceptedPi = interceptSessionStart(pi, (context) => safeCaptureBinding(root, controller, context));
    const installGate = registerTeamWorkflow(interceptedPi, {
      ...options,
      cwd: root,
      owner: () => registration.owner,
      registrationToken: registration.token,
      onSessionBindingController: (candidate) => {
        controller = candidate;
        safeCaptureBinding(root, controller, TEST_CONTEXT(root));
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
