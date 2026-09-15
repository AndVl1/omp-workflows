import { afterEach as nodeTestAfterEach } from "node:test";
import { existsSync } from "node:fs";
import { registerConstitutionTools, registerCtoTools, registerTeamWorkflow, registerWorkflowTools, type TeamSessionBindingController, type TeamSessionRuntimeBinding } from "../../src/index.js";
import { closeRegistryRegistrationContext } from "../../src/registry/owner.js";
import { revokeCtoRuntimeSessionAuthority } from "../../src/cto/session-authority.js";
import { TEST_CONTEXT } from "./registrar-host.js";
import {
  closeRetainedTestRegistrations,
  openTestRegistry,
  writeTestRegistryMarker,
  type TestRegistryRegistration,
} from "./registry-activation.js";

type TeamSessionCaptureState = {
  controller?: TeamSessionBindingController;
  closed: boolean;
};
type RetainedTestTeamSession = {
  readonly state: TeamSessionCaptureState;
  readonly controller: TeamSessionBindingController;
  readonly bindings: Map<string, TeamSessionRuntimeBinding>;
};
const activeTestTeamCaptures = new Set<TeamSessionCaptureState>();
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
  state: TeamSessionCaptureState,
  binding: TeamSessionRuntimeBinding,
): void {
  if (state.closed) return;
  const controller = state.controller;
  if (!controller) return;
  const retained = [...retainedTestTeamSessions].find((candidate) => candidate.state === state);
  if (retained) {
    retained.bindings.set(retainedBindingKey(binding), binding);
    return;
  }
  retainedTestTeamSessions.add({
    state,
    controller,
    bindings: new Map([[retainedBindingKey(binding), binding]]),
  });
}

function releaseBinding(
  controller: TeamSessionBindingController,
  binding: TeamSessionRuntimeBinding,
  onError?: (error: unknown) => void,
): void {
  let released = false;
  try {
    released = controller.release(binding);
  } catch (error) {
    onError?.(error);
  }
  if (released) return;
  try { binding.runtimeAccess.close(); } catch (error) { onError?.(error); }
  try { revokeCtoRuntimeSessionAuthority(binding.runtimeAuthority); } catch (error) { onError?.(error); }
  try { closeRegistryRegistrationContext(binding.registryContext); } catch (error) { onError?.(error); }
}

function safeCaptureBinding(
  root: string,
  state: TeamSessionCaptureState,
  context: unknown,
): void {
  const controller = state.controller;
  if (!controller) return;
  try {
    const binding = controller.current(context) ?? (existsSync(root) ? controller.current(TEST_CONTEXT(root)) : null);
    if (!binding) return;
    if (state.closed) {
      releaseBinding(controller, binding);
      return;
    }
    retainBinding(state, binding);
  } catch {
    // The session handler's result/throw semantics must not change because
    // fixture evidence capture is best-effort after the handler has run.
  }
}

type HostOn = (event: unknown, handler: unknown, ...rest: unknown[]) => unknown;

function installSessionStartInterceptor(
  pi: Parameters<typeof registerTeamWorkflow>[0],
  capture: (context: unknown) => void,
): () => void {
  const target = pi as object;
  const descriptor = Object.getOwnPropertyDescriptor(target, "on");
  const originalOn = Reflect.get(target, "on") as unknown;
  if (typeof originalOn !== "function") return () => undefined;
  const wrappedOn: HostOn = function (this: unknown, event: unknown, handler: unknown, ...rest: unknown[]): unknown {
    if (event !== "session_start" || typeof handler !== "function") {
      return Reflect.apply(originalOn, this, [event, handler, ...rest]);
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
        } catch {
          capture(context);
          return result;
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
    return Reflect.apply(originalOn, this, [event, wrappedHandler, ...rest]);
  };
  Object.defineProperty(target, "on", {
    ...(descriptor ?? {}),
    configurable: descriptor?.configurable ?? true,
    enumerable: descriptor?.enumerable ?? true,
    writable: true,
    value: wrappedOn,
  });
  return () => {
    if (descriptor) Object.defineProperty(target, "on", descriptor);
    else delete (target as { on?: unknown }).on;
  };
}

/** Release exact mounted test-session runtime capabilities before registry fixtures close. */
export function closeRetainedTestTeamSessions(): void {
  const captures = [...activeTestTeamCaptures];
  for (const state of captures) state.closed = true;
  activeTestTeamCaptures.clear();
  const sessions = [...retainedTestTeamSessions];
  retainedTestTeamSessions.clear();
  let firstError: unknown;
  let hasError = false;
  const rememberError = (error: unknown): void => {
    if (!hasError) {
      firstError = error;
      hasError = true;
    }
  };
  for (const session of sessions) {
    for (const binding of [...session.bindings.values()].reverse()) {
      releaseBinding(session.controller, binding, rememberError);
    }
    session.bindings.clear();
  }
  retainedTestTeamSessions.clear();
  if (hasError) throw firstError;
}

nodeTestAfterEach(() => {
  let firstError: unknown;
  let hasError = false;
  try {
    closeRetainedTestTeamSessions();
  } catch (error) {
    firstError = error;
    hasError = true;
  }
  try {
    closeRetainedTestRegistrations();
  } catch (error) {
    if (!hasError) {
      firstError = error;
      hasError = true;
    }
  }
  if (hasError) throw firstError;
});

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
  const captureState: TeamSessionCaptureState = { closed: false };
  activeTestTeamCaptures.add(captureState);
  let restoreOn: () => void = () => undefined;
  try {
    restoreOn = installSessionStartInterceptor(pi, (context) => safeCaptureBinding(root, captureState, context));
    const installGate = registerTeamWorkflow(pi, {
      ...options,
      cwd: root,
      owner: () => registration.owner,
      registrationToken: registration.token,
      onSessionBindingController: (candidate) => {
        captureState.controller = candidate;
        safeCaptureBinding(root, captureState, TEST_CONTEXT(root));
        options.onSessionBindingController?.(candidate);
      },
    });
    if (installGate) installGate();
    registration.retain(true);
  } catch (error) {
    try { registration.finish(false); } catch { /* preserve original */ }
    throw error;
  } finally {
    restoreOn();
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
