import { join } from "node:path";
import { writeTestRegistryMarker } from "./registry-activation.js";

export const TEST_OWNER = (cwd: string) => {
  const marker = writeTestRegistryMarker(cwd);
  return {
    owner_id: "core-test",
    bundle_id: "core-test",
    owner_kind: "private_omp" as const,
    activation_marker: "core-test-activation",
    activation: { marker_id: "core-test-activation", required: [{ path: marker.path, kind: "file" as const, sha256: marker.sha256 }] },
    host_range: ">=17.3 <19",
    provenance: { package: "@andvl1/omp-workflows-core", entrypoint: "test", cwd },
  };
};

const TEST_SESSION_GENERATION = "registrar-test-session-generation";

export const TEST_SESSION_MANAGER = {
  cwd: ".",
  getSessionId: () => "registrar-test-session",
  getSessionFile: () => join(TEST_SESSION_MANAGER.cwd, "registrar-test-session.jsonl"),
  getSessionGeneration: () => TEST_SESSION_GENERATION,
  getCwd: () => TEST_SESSION_MANAGER.cwd,
};

export const TEST_SESSION_UI = {
  askDialog: async (questions: Array<{ id: string; question: string; options?: Array<{ label: string }> }>) => ({
    kind: "submit" as const,
    results: [{
      id: questions[0]?.id ?? "",
      question: questions[0]?.question ?? "",
      options: (questions[0]?.options ?? []).map((option) => option.label),
      multi: false,
      selectedOptions: [questions[0]?.options?.[0]?.label ?? "approve_continue"],
    }],
  }),
};

export function TEST_CONTEXT(cwd: string): { cwd: string; mode: "rpc"; hasUI: true; sessionManager: typeof TEST_SESSION_MANAGER; ui: typeof TEST_SESSION_UI } {
  TEST_SESSION_MANAGER.cwd = cwd;
  return { cwd, mode: "rpc", hasUI: true, sessionManager: TEST_SESSION_MANAGER, ui: TEST_SESSION_UI };
}

export function TEST_ON(event: string, handler: (event: unknown, ctx: unknown) => unknown): void {
  if (event === "session_start") handler({}, TEST_CONTEXT("."));
}
