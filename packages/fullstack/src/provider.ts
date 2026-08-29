import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import {
  computeCatalogContentDigest,
  computeDescriptorFingerprint,
  createDiagnostic,
  createProviderCatalog,
  createProviderId,
  failureResult,
  publishProvider,
  validateProviderDescriptor,
  type AgentRef,
  type CatalogProfile,
  type DiagnosticResult,
  type ExecutableProvenance,
  type Profile,
  type ProviderCatalog,
  type ProviderDescriptor,
  type ProviderId,
  type ProviderRecord,
  type ProviderRegistration,
  type ProviderRegistry,
  type ScopeRule,
  type WorkflowV2Digest,
} from "@andvl1/omp-workflows-core";
import { createFullstackProviderRuntime } from "./provider-runtime.js";

type ProviderAgentSource = ProviderDescriptor["agent_sources"][number];

const PROVIDER_ID_TEXT = "@andvl1/omp-workflows-fullstack";
const providerId = createProviderId(PROVIDER_ID_TEXT);
if (!providerId) throw new Error(`invalid fullstack provider id: ${PROVIDER_ID_TEXT}`);

/** Exact package-qualified identity published by this bundle. */
export const FULLSTACK_PROVIDER_ID: ProviderId = providerId;

const AGENT_NAMES = [
  "analyst",
  "architect",
  "code-reviewer",
  "cto",
  "developer-go",
  "developer-kotlin",
  "developer-mobile",
  "devops",
  "diagnostics",
  "discovery",
  "frontend-developer",
  "init-mobile",
  "manual-qa",
  "product-analyst",
  "product-critic",
  "product-researcher",
  "product-strategist",
  "qa",
  "security-tester",
  "team-lead",
  "tech-researcher",
] as const;

/** Workflow assets owned by core and consumed through its exported package path. */
const CORE_PROFILE_ASSETS = [
  "bug-fix.json",
  "cto.json",
  "debug-cycle.json",
  "emergency.json",
  "feature-regression.json",
  "full-feature.json",
  "lightweight.json",
  "product-discovery.json",
  "research.json",
  "review.json",
  "spec-preparation.json",
  "standard.json",
] as const;

const require = createRequire(import.meta.url);

type Material = readonly [name: string, bytes: Uint8Array];

function digestBytes(bytes: Uint8Array): WorkflowV2Digest {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}` as WorkflowV2Digest;
}

function digestMaterials(materials: readonly Material[]): WorkflowV2Digest {
  const hash = createHash("sha256");
  for (const [name, bytes] of materials) {
    hash.update(name, "utf8");
    hash.update("\0", "utf8");
    hash.update(bytes);
    hash.update("\0", "utf8");
  }
  return `sha256:${hash.digest("hex")}` as WorkflowV2Digest;
}

function packageAsset(relativePath: string): string {
  return fileURLToPath(new URL(relativePath, import.meta.url));
}

function readPackageAsset(relativePath: string): Uint8Array {
  return readFileSync(packageAsset(relativePath));
}

function readCoreProfileAsset(asset: string): { readonly profile: Profile; readonly bytes: Uint8Array } {
  const path = require.resolve(`@andvl1/omp-workflows-core/workflows/${asset}`);
  const bytes = readFileSync(path);
  const profileWithMetadata = JSON.parse(bytes.toString("utf8")) as Profile & {
    readonly $schema?: string;
  };
  // `$schema` is packaging metadata present in the exported JSON assets, not a
  // workflow-profile field. Project the same metadata-free value used by core's
  // canonical profile loader, while retaining raw bytes for provenance.
  const { $schema: _schema, ...profile } = profileWithMetadata;
  return { profile, bytes };
}

const agentMaterials = AGENT_NAMES.map((name): Material => [
  `agents/${name}.md`,
  readPackageAsset(`../agents/${name}.md`),
]);

const sourceEntries = AGENT_NAMES.map((name) => {
  const source_fingerprint = digestBytes(agentMaterials.find(([path]) => path === `agents/${name}.md`)![1]);
  const ref: AgentRef = Object.freeze({
    registered_name: name,
    provider_id: FULLSTACK_PROVIDER_ID,
    source_fingerprint,
  });
  const source: ProviderAgentSource = Object.freeze({
    provider_id: FULLSTACK_PROVIDER_ID,
    source_fingerprint,
    registered_names: Object.freeze([name]),
  });
  return Object.freeze({ name, ref, source });
});

const sourceByName = new Map<string, AgentRef>(sourceEntries.map(({ name, ref }) => [name, ref]));

function agentRef(name: string): AgentRef {
  const ref = sourceByName.get(name);
  if (!ref) throw new Error(`fullstack provider source is missing agent '${name}'`);
  return ref;
}

/** Every bundled agent retains the exact provider/source provenance. */
export const FULLSTACK_PROVIDER_AGENT_SOURCES: readonly ProviderAgentSource[] = Object.freeze(
  sourceEntries.map(({ source }) => source),
);

/** Provider-qualified references used by descriptor defaults and runtime policy. */
export const FULLSTACK_PROVIDER_AGENT_REFS: Readonly<Record<string, AgentRef>> = Object.freeze(
  Object.fromEntries(sourceEntries.map(({ name, ref }) => [name, ref])),
);

const roleAgentNames: Readonly<Record<string, string>> = Object.freeze({
  analyst: "analyst",
  "tech-researcher": "tech-researcher",
  diagnostics: "diagnostics",
  architect: "architect",
  architect_minimal: "architect",
  architect_clean: "architect",
  architect_pragmatic: "architect",
  "backend-kotlin": "developer-kotlin",
  go: "developer-go",
  frontend: "frontend-developer",
  mobile: "developer-mobile",
  android: "developer-mobile",
  qa: "qa",
  "manual-qa": "manual-qa",
  "code-reviewer": "code-reviewer",
  "security-tester": "security-tester",
  devops: "devops",
  "regression-planner": "analyst",
  "regression-executor": "manual-qa",
  "regression-oracle": "qa",
  "product-analyst": "product-analyst",
  "product-researcher": "product-researcher",
  "product-critic": "product-critic",
  "product-strategist": "product-strategist",
});

const roleDefaults: Readonly<Record<string, AgentRef>> = Object.freeze(
  Object.fromEntries(Object.entries(roleAgentNames).map(([role, name]) => [role, agentRef(name)])),
);

const scopeDefaults: readonly ScopeRule[] = Object.freeze([
  Object.freeze({
    patterns: Object.freeze(["**/iosApp/**", "**/composeApp/**", "**/commonMain/**", "**/androidMain/**"]),
    scope: "mobile",
    dev_agent: agentRef("developer-mobile"),
    runtime_class: "runtime",
    ui_class: true,
  }),
  Object.freeze({
    patterns: Object.freeze(["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.ts", "**/src/jsMain/**", "**/miniapp/**", "**/frontend/**"]),
    scope: "frontend",
    dev_agent: agentRef("frontend-developer"),
    runtime_class: "runtime",
    ui_class: true,
  }),
  Object.freeze({
    patterns: Object.freeze(["**/*.go", "**/go.mod", "**/go.sum"]),
    scope: "go",
    dev_agent: agentRef("developer-go"),
    runtime_class: "runtime",
    ui_class: false,
  }),
  Object.freeze({
    patterns: Object.freeze(["**/Dockerfile", "**/*.yaml", "**/*.yml", "**/helm/**", "**/.github/**", "**/k8s/**"]),
    scope: "devops",
    dev_agent: agentRef("devops"),
    runtime_class: "runtime",
    ui_class: false,
  }),
  Object.freeze({
    patterns: Object.freeze(["**/*.kt", "**/*.java", "**/src/main/**"]),
    scope: "backend-kotlin",
    dev_agent: agentRef("developer-kotlin"),
    runtime_class: "runtime",
    ui_class: false,
  }),
]);

const profileAssets = CORE_PROFILE_ASSETS.map((asset) => readCoreProfileAsset(asset));
const catalogProfiles: readonly Profile[] = Object.freeze(profileAssets.map(({ profile }) => profile));

/** Immutable profile catalog; core assets are loaded only through the exported package subpath. */
export const FULLSTACK_PROVIDER_CATALOG: Readonly<ProviderCatalog> = createProviderCatalog(catalogProfiles);
export const FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST: WorkflowV2Digest = computeCatalogContentDigest(FULLSTACK_PROVIDER_CATALOG);

const packageMaterials: readonly Material[] = Object.freeze([
  ["package.json", readPackageAsset("../package.json")],
  ...agentMaterials,
  ...profileAssets.map(({ bytes }, index) => [`workflows/${CORE_PROFILE_ASSETS[index]}`, bytes] as Material),
]);

const runtimeMaterials: readonly Material[] = Object.freeze([
  ["provider-runtime.factory", new TextEncoder().encode(createFullstackProviderRuntime.toString())],
  ...["./provider-runtime.ts", "./provider-runtime.js"]
    .filter((relativePath) => existsSync(packageAsset(relativePath)))
    .map((relativePath) => [`src/${relativePath.slice(2)}`, readPackageAsset(relativePath)] as Material),
]);

const executableProvenance: ExecutableProvenance = Object.freeze({
  build_fingerprint: digestMaterials(packageMaterials),
  runtime_fingerprint: digestMaterials(runtimeMaterials),
});

const commandDefaults = Object.freeze({
  "do-work": Object.freeze({ fragments: Object.freeze([]) }),
  team: Object.freeze({ alias_of: "do-work" as const }),
  cto: Object.freeze({ fragments: Object.freeze([]) }),
});

const descriptorDefaults: ProviderDescriptor["defaults"] = Object.freeze({
  roles: roleDefaults,
  scope_map: scopeDefaults,
  roster_overrides: Object.freeze([]),
  flags: Object.freeze({}),
  runtime_classes: Object.freeze({
    "backend-kotlin": "runtime",
    go: "runtime",
    frontend: "runtime",
    mobile: "runtime",
    devops: "runtime",
  }),
  ui_classes: Object.freeze({ frontend: true, mobile: true }),
  design_system: null,
  commands: commandDefaults,
  workflow: Object.freeze({ selection: "matrix" as const }),
  prompt_context: Object.freeze({}),
  required_capabilities: Object.freeze(["workflow_execution", "cto", "profile_catalog"]),
});

const descriptorInput: ProviderDescriptor = {
  id: FULLSTACK_PROVIDER_ID,
  protocol_version: 2,
  capabilities: Object.freeze(["workflow_execution", "cto", "profile_catalog"]),
  catalog_content_digest: FULLSTACK_PROVIDER_CATALOG_CONTENT_DIGEST,
  agent_sources: FULLSTACK_PROVIDER_AGENT_SOURCES,
  executable_provenance: executableProvenance,
  defaults: descriptorDefaults,
};

const descriptorResult = validateProviderDescriptor(descriptorInput);
if (!descriptorResult.ok) {
  throw new Error(`invalid fullstack provider descriptor: ${descriptorResult.diagnostics.map(({ remediation }) => remediation).join("; ")}`);
}

/** One immutable provider descriptor with exact source, executable and catalog identity. */
export const FULLSTACK_PROVIDER_DESCRIPTOR: Readonly<ProviderDescriptor> = descriptorResult.value;
export const FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT: WorkflowV2Digest = computeDescriptorFingerprint(FULLSTACK_PROVIDER_DESCRIPTOR);

/** Pure registration builder; retaining it never invokes the runtime factory. */
export function createFullstackProviderRegistration(): Readonly<ProviderRegistration> {
  return Object.freeze({
    descriptor: FULLSTACK_PROVIDER_DESCRIPTOR,
    descriptor_fingerprint: FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
    catalog: FULLSTACK_PROVIDER_CATALOG,
    createRuntime: createFullstackProviderRuntime,
  });
}

export const FULLSTACK_PROVIDER_REGISTRATION: Readonly<ProviderRegistration> = createFullstackProviderRegistration();

const INVALID_FULLSTACK_DESCRIPTOR_FINGERPRINT = `sha256:${"0".repeat(64)}` as WorkflowV2Digest;

function isCanonicalFullstackProviderRecord(record: ProviderRecord): boolean {
  const registration = FULLSTACK_PROVIDER_REGISTRATION;
  try {
    return record.provider_id === FULLSTACK_PROVIDER_ID
      && record.provider_id === registration.descriptor.id
      && record.descriptor.id === registration.descriptor.id
      && record.descriptor.protocol_version === registration.descriptor.protocol_version
      && record.descriptor.catalog_content_digest === registration.descriptor.catalog_content_digest
      && record.descriptor_fingerprint === registration.descriptor_fingerprint
      && computeDescriptorFingerprint(record.descriptor) === registration.descriptor_fingerprint
      && record.catalog.content_digest === registration.catalog.content_digest
      && computeCatalogContentDigest(record.catalog) === registration.catalog.content_digest
      && record.createRuntime === registration.createRuntime;
  } catch {
    return false;
  }
}

function quarantineMismatchedFullstackPublication(registry: ProviderRegistry): DiagnosticResult<ProviderRecord> {
  const quarantine = publishProvider(registry, {
    ...FULLSTACK_PROVIDER_REGISTRATION,
    descriptor_fingerprint: INVALID_FULLSTACK_DESCRIPTOR_FINGERPRINT,
  });
  if (!quarantine.ok) return quarantine;
  return failureResult(createDiagnostic({
    code: "PROVIDER_QUARANTINED",
    operation: "provider.lookup",
    evidence: {
      provider_id: FULLSTACK_PROVIDER_ID,
      descriptor_fingerprint: FULLSTACK_PROVIDER_DESCRIPTOR_FINGERPRINT,
    },
    remediation: "Restart the host lifecycle and publish only the exact fullstack registration with its canonical runtime factory.",
  }));
}

/** Publish exactly this immutable registration into an explicit host-owned registry. */
export function publishFullstackProvider(registry: ProviderRegistry): DiagnosticResult<ProviderRecord> {
  const published = publishProvider(registry, FULLSTACK_PROVIDER_REGISTRATION);
  if (!published.ok) return published;
  if (isCanonicalFullstackProviderRecord(published.value)) return published;
  return quarantineMismatchedFullstackPublication(registry);
}

/** Profile identities exposed for host policy/binding construction. */
export const FULLSTACK_PROVIDER_PROFILE_IDENTITIES: readonly CatalogProfile[] = FULLSTACK_PROVIDER_CATALOG.profiles;
