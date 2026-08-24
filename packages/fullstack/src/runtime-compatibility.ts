import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  WorkflowRuntimeContract,
  WorkflowRuntimePackage,
} from "@andvl1/omp-workflows-core";
import * as core from "@andvl1/omp-workflows-core";

const RUNTIME_PROTOCOL = "omp-workflows-runtime/v1" as const;
const HANDOFF_CAPABILITY = "workflow_handoff" as const;
const CORE_PACKAGE_NAME = "@andvl1/omp-workflows-core";
const FULLSTACK_PACKAGE_NAME = "@andvl1/omp-workflows-fullstack";

export class WorkflowRuntimeCompatibilityError extends Error {
  readonly code = "WORKFLOW_RUNTIME_INCOMPATIBLE" as const;

  constructor(message: string) {
    super(message);
    this.name = "WorkflowRuntimeCompatibilityError";
  }
}

function packageDescriptor(moduleUrl: string, fallbackName: string): WorkflowRuntimePackage {
  const path = fileURLToPath(moduleUrl);
  const packageJsonPath = resolve(dirname(path), "..", "package.json");
  try {
    const parsed = JSON.parse(readFileSync(packageJsonPath, "utf8")) as { name?: unknown; version?: unknown };
    return {
      name: typeof parsed.name === "string" ? parsed.name : fallbackName,
      version: typeof parsed.version === "string" ? parsed.version : "unknown",
      path,
    };
  } catch {
    return { name: fallbackName, version: "unknown", path };
  }
}

const FULLSTACK_PACKAGE = packageDescriptor(import.meta.url, FULLSTACK_PACKAGE_NAME);

export const FULLSTACK_RUNTIME_CONTRACT: WorkflowRuntimeContract = Object.freeze({
  protocol: RUNTIME_PROTOCOL,
  package: FULLSTACK_PACKAGE,
  capabilities: [HANDOFF_CAPABILITY],
  requires: [HANDOFF_CAPABILITY],
});

function fallbackCorePackage(): WorkflowRuntimePackage {
  try {
    const moduleUrl = import.meta.resolve(CORE_PACKAGE_NAME);
    return packageDescriptor(moduleUrl, CORE_PACKAGE_NAME);
  } catch {
    return { name: CORE_PACKAGE_NAME, version: "unknown", path: "unknown" };
  }
}

function normalizePackage(value: unknown, fallback: WorkflowRuntimePackage): WorkflowRuntimePackage {
  if (!value || typeof value !== "object") return fallback;
  const candidate = value as Partial<WorkflowRuntimePackage>;
  return {
    name: typeof candidate.name === "string" ? candidate.name : fallback.name,
    version: typeof candidate.version === "string" ? candidate.version : "unknown",
    path: typeof candidate.path === "string" ? candidate.path : fallback.path,
  };
}

function coreContractOf(coreModule: Record<string, unknown>): WorkflowRuntimeContract | undefined {
  const getter = coreModule.getCoreRuntimeContract;
  if (typeof getter === "function") {
    try {
      const contract = getter() as unknown;
      if (contract && typeof contract === "object") return contract as WorkflowRuntimeContract;
    } catch {
      // Continue to the immutable export so a broken diagnostic helper cannot
      // mask the actual missing capability.
    }
  }
  const exported = coreModule.CORE_RUNTIME_CONTRACT;
  return exported && typeof exported === "object" ? exported as WorkflowRuntimeContract : undefined;
}

/**
 * Fail before registration when the extension and its core peer are not one
 * release/runtime contract. Namespace inspection is intentional: an older
 * core can omit `handoffWorkflow` without causing ESM's generic named-export
 * error before this diagnostic runs.
 */
export function assertWorkflowRuntimeCompatibility(coreModule: unknown = core): asserts coreModule is Record<string, unknown> {
  const loadedCore = coreModule && typeof coreModule === "object" ? coreModule as Record<string, unknown> : {};
  const coreContract = coreContractOf(loadedCore);
  const loadedCorePackage = normalizePackage(coreContract?.package, fallbackCorePackage());
  const failures: string[] = [];

  if (!coreContract) {
    failures.push("the core runtime contract is missing");
  } else {
    if (coreContract.protocol !== RUNTIME_PROTOCOL) {
      failures.push(`runtime protocol must be ${RUNTIME_PROTOCOL}`);
    }
    if (loadedCorePackage.name !== CORE_PACKAGE_NAME) {
      failures.push(`loaded core package is ${loadedCorePackage.name}, not ${CORE_PACKAGE_NAME}`);
    }
    if (loadedCorePackage.version !== FULLSTACK_PACKAGE.version) {
      failures.push(`package versions differ (core=${loadedCorePackage.version}, fullstack=${FULLSTACK_PACKAGE.version})`);
    }
    if (!Array.isArray(coreContract.capabilities) || !coreContract.capabilities.includes(HANDOFF_CAPABILITY)) {
      failures.push(`core contract does not provide the ${HANDOFF_CAPABILITY} capability`);
    }
  }

  if (typeof loadedCore.handoffWorkflow !== "function") {
    failures.push("the loaded core export handoffWorkflow is missing, so workflow_handoff cannot be registered");
  }

  if (failures.length === 0) return;

  throw new WorkflowRuntimeCompatibilityError(
    `Incompatible omp workflow runtime: ${failures.join("; ")}. ` +
      `Loaded ${CORE_PACKAGE_NAME} version=${loadedCorePackage.version} path=${loadedCorePackage.path}; ` +
      `loaded ${FULLSTACK_PACKAGE_NAME} version=${FULLSTACK_PACKAGE.version} path=${FULLSTACK_PACKAGE.path}. ` +
      "Rebuild both @andvl1/omp-workflows-core and @andvl1/omp-workflows-fullstack from the same checkout, install the matched pair, and restart OMP.",
  );
}
