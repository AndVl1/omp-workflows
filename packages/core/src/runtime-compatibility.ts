import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const WORKFLOW_RUNTIME_PROTOCOL = "omp-workflows-runtime/v1" as const;
export const WORKFLOW_HANDOFF_CAPABILITY = "workflow_handoff" as const;
export const FULLSTACK_RUNTIME_LABEL = "omp-workflows-fullstack" as const;
const FULLSTACK_PACKAGE_NAME = "@andvl1/omp-workflows-fullstack";

export interface WorkflowRuntimePackage {
  name: string;
  version: string;
  /** Loaded module entrypoint, not a source-control or package-manager guess. */
  path: string;
}

export interface WorkflowRuntimeContract {
  protocol: typeof WORKFLOW_RUNTIME_PROTOCOL;
  package: WorkflowRuntimePackage;
  capabilities?: readonly string[];
  requires?: readonly string[];
}

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

export const CORE_RUNTIME_CONTRACT: WorkflowRuntimeContract = Object.freeze({
  protocol: WORKFLOW_RUNTIME_PROTOCOL,
  package: packageDescriptor(import.meta.url, "@andvl1/omp-workflows-core"),
  capabilities: [WORKFLOW_HANDOFF_CAPABILITY],
});

function fallbackBundlePackage(): WorkflowRuntimePackage {
  try {
    const moduleUrl = import.meta.resolve(FULLSTACK_PACKAGE_NAME);
    return packageDescriptor(moduleUrl, FULLSTACK_PACKAGE_NAME);
  } catch {
    return {
      name: FULLSTACK_PACKAGE_NAME,
      version: "unknown",
      path: "unknown",
    };
  }
}


export function getCoreRuntimeContract(): WorkflowRuntimeContract {
  return CORE_RUNTIME_CONTRACT;
}

function packageSummary(pkg: WorkflowRuntimePackage): string {
  return `${pkg.name} version=${pkg.version} path=${pkg.path}`;
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

/**
 * Validate the fullstack declaration before the core wires any OMP hooks.
 *
 * Requiring a declaration on the well-known fullstack label means a stale
 * fullstack extension loaded with a newer core fails at extension load instead
 * of silently registering an incomplete tool surface.
 */
export function assertWorkflowBundleCompatibility(contract: unknown): asserts contract is WorkflowRuntimeContract {
  const bundle = contract && typeof contract === "object" ? contract as Partial<WorkflowRuntimeContract> : undefined;
  const loadedCore = CORE_RUNTIME_CONTRACT.package;
  const loadedBundle = normalizePackage(bundle?.package, fallbackBundlePackage());
  const failures: string[] = [];

  if (!bundle) {
    failures.push("the fullstack runtime contract is missing");
  } else {
    if (bundle.protocol !== WORKFLOW_RUNTIME_PROTOCOL) {
      failures.push(`runtime protocol must be ${WORKFLOW_RUNTIME_PROTOCOL}`);
    }
    if (loadedBundle.name !== "@andvl1/omp-workflows-fullstack") {
      failures.push("the loaded bundle is not @andvl1/omp-workflows-fullstack");
    }
    if (loadedBundle.version !== loadedCore.version) {
      failures.push(`package versions differ (core=${loadedCore.version}, fullstack=${loadedBundle.version})`);
    }
    if (!Array.isArray(bundle.requires) || !bundle.requires.includes(WORKFLOW_HANDOFF_CAPABILITY)) {
      failures.push(`fullstack does not require the ${WORKFLOW_HANDOFF_CAPABILITY} capability`);
    }
  }

  if (failures.length === 0) return;

  throw new WorkflowRuntimeCompatibilityError(
    `Incompatible omp workflow runtime: ${failures.join("; ")}. ` +
      `Loaded ${packageSummary(loadedCore)}; loaded ${packageSummary(loadedBundle)}. ` +
      "Rebuild both @andvl1/omp-workflows-core and @andvl1/omp-workflows-fullstack from the same checkout, install the matched pair, and restart OMP.",
  );
}
