import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
	computeCatalogContentDigest,
	computeDescriptorFingerprint,
	canonicalPolicyJson,
	createDiagnostic,
	createProviderCatalog,
	createProviderId,
	effectivePolicyFromSnapshot,
	failureResult,
	isCanonicalRoot,
	isProviderId,
	isWorkflowV2Digest,
	lookupProvider,
	preflightAgentInventory,
	projectRuntimeKeyFor,
	publishProvider,
	successResult,
	validateProviderActivationAdmission,
	validateProviderCatalog,
	validateProjectIdentity,
	validateProviderAgentInventory,
	validateProviderDescriptor,
	type ActualAgentInventory,
	type AgentInventoryAuthority,
	type AgentInventoryAuthorityContext,
	type AgentRef,
	type DiagnosticResult,
	type ProviderActivationAdmission,
	type ProviderActivationAdmissionExpectation,
	type ProviderCatalog,
	type ProviderDescriptor,
	type ProviderDispatchResult,
	type ProviderId,
	type ProviderRecord,
	type ProviderRegistration,
	type ProviderRegistry,
	type ProviderRuntime,
	type ProviderRuntimeContext,
	type ProjectIdentity,
	type ScopeRule,
	type ValidatedDispatch,
	type WorkflowV2Digest,
	type WorkflowV2Diagnostic,
} from "@andvl1/omp-workflows-core";

import {
	detectWorkspaceMarkers,
	workspaceMarkerRoot,
	type WorkspaceMarkerCapability,
} from "./activation.js";
import { OMP_INTERNAL_ACTIVATION_MARKER, OMP_INTERNAL_BUNDLE_ID } from "./identity.js";
import { readInternalWorkflowProfiles } from "./profiles.js";

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const AGENT_ASSET_NAMES = [
	"omp-team-lead",
	"omp-analyst",
	"omp-tech-researcher",
	"omp-diagnostics",
	"omp-architect",
	"omp-qa",
	"omp-manual-qa",
	"omp-code-reviewer",
	"omp-security-tester",
	"omp-devops",
	"omp-plugin-developer",
	"omp-engine-specialist",
	"omp-host-integration-specialist",
	"omp-package-release-specialist",
] as const;

export const INTERNAL_PROVIDER_ID: ProviderId = createProviderId(OMP_INTERNAL_BUNDLE_ID) ?? (() => {
	throw new Error(`invalid provider id '${OMP_INTERNAL_BUNDLE_ID}'`);
})();

function digestFiles(files: readonly string[]): `sha256:${string}` {
	const hash = createHash("sha256");
	for (const file of files) {
		hash.update(relative(PACKAGE_ROOT, file), "utf8");
		hash.update("\0", "utf8");
		hash.update(readFileSync(file));
		hash.update("\0", "utf8");
	}
	return `sha256:${hash.digest("hex")}`;
}

function agentAssetPath(name: string): string {
	return join(PACKAGE_ROOT, "agents", `${name}.md`);
}

const AGENT_SOURCE_FINGERPRINTS: ReadonlyMap<string, `sha256:${string}`> = new Map(
	AGENT_ASSET_NAMES.map((name) => [name, digestFiles([agentAssetPath(name)])]),
);

function agentRef(name: string): AgentRef {
	const sourceFingerprint = AGENT_SOURCE_FINGERPRINTS.get(name);
	if (!sourceFingerprint) throw new Error(`missing internal agent source '${name}'`);
	return Object.freeze({
		registered_name: name,
		provider_id: INTERNAL_PROVIDER_ID,
		source_fingerprint: sourceFingerprint,
	});
}

const AGENT_REFS: ReadonlyMap<string, AgentRef> = new Map(
	AGENT_ASSET_NAMES.map((name) => [name, agentRef(name)]),
);

function role(name: string): AgentRef {
	const value = AGENT_REFS.get(name);
	if (!value) throw new Error(`missing internal agent ref '${name}'`);
	return value;
}

const INTERNAL_ROLES: Readonly<Record<string, AgentRef>> = Object.freeze({
	"team-lead": role("omp-team-lead"),
	analyst: role("omp-analyst"),
	"tech-researcher": role("omp-tech-researcher"),
	diagnostics: role("omp-diagnostics"),
	architect: role("omp-architect"),
	architect_minimal: role("omp-architect"),
	architect_clean: role("omp-architect"),
	architect_pragmatic: role("omp-architect"),
	developer: role("omp-engine-specialist"),
	qa: role("omp-qa"),
	"manual-qa": role("omp-manual-qa"),
	"code-reviewer": role("omp-code-reviewer"),
	"security-tester": role("omp-security-tester"),
	devops: role("omp-devops"),
	"plugin-developer": role("omp-plugin-developer"),
	"host-integration": role("omp-host-integration-specialist"),
	"package-release": role("omp-package-release-specialist"),
});

const INTERNAL_SCOPE_MAP: readonly ScopeRule[] = Object.freeze([
	Object.freeze({
		patterns: Object.freeze(["**/Dockerfile", "**/*.yaml", "**/*.yml", "**/helm/**", "**/.github/workflows/**"]),
		scope: "devops",
		dev_agent: role("omp-devops"),
		runtime_class: "runtime",
	}),
	Object.freeze({
		patterns: Object.freeze(["packages/**/*.ts", "*.ts", "*.json"]),
		scope: "dev",
		dev_agent: role("omp-engine-specialist"),
		runtime_class: "runtime",
	}),
]);

const INTERNAL_COMMAND_DEFAULTS = Object.freeze({
	"do-work": Object.freeze({ fragments: Object.freeze([]) }),
	team: Object.freeze({ alias_of: "do-work" as const }),
	cto: Object.freeze({ fragments: Object.freeze([]) }),
});

const INTERNAL_DESCRIPTOR_DEFAULTS: ProviderDescriptor["defaults"] = Object.freeze({
	roles: INTERNAL_ROLES,
	scope_map: INTERNAL_SCOPE_MAP,
	roster_overrides: Object.freeze([]),
	flags: Object.freeze({}),
	runtime_classes: Object.freeze({ devops: "runtime", dev: "runtime" }),
	ui_classes: Object.freeze({}),
	commands: INTERNAL_COMMAND_DEFAULTS,
});

const catalogProfiles = readInternalWorkflowProfiles();
export const INTERNAL_PROVIDER_CATALOG: Readonly<ProviderCatalog> = createProviderCatalog(catalogProfiles);

const providerSourceFiles = AGENT_ASSET_NAMES.map(agentAssetPath);
const profileAssetFiles = [
	join(PACKAGE_ROOT, "workflows", "omp-feature.json"),
	join(PACKAGE_ROOT, "workflows", "omp-validate.json"),
];
const packageManifest = join(PACKAGE_ROOT, "package.json");
const runtimeModule = existsSync(join(PACKAGE_ROOT, "src", "provider.ts"))
	? join(PACKAGE_ROOT, "src", "provider.ts")
	: join(PACKAGE_ROOT, "dist", "provider.js");
const INTERNAL_EXECUTABLE_PROVENANCE = Object.freeze({
	build_fingerprint: digestFiles([packageManifest, ...providerSourceFiles, ...profileAssetFiles, runtimeModule]),
	runtime_fingerprint: digestFiles([runtimeModule, ...providerSourceFiles, ...profileAssetFiles]),
});

export const INTERNAL_PROVIDER_DESCRIPTOR: Readonly<ProviderDescriptor> = Object.freeze({
	id: INTERNAL_PROVIDER_ID,
	protocol_version: 2,
	capabilities: Object.freeze(["workflow_execution", "cto", "profile_catalog"]),
	catalog_content_digest: INTERNAL_PROVIDER_CATALOG.content_digest,
	agent_sources: Object.freeze(
		AGENT_ASSET_NAMES.map((name) =>
			Object.freeze({
				provider_id: INTERNAL_PROVIDER_ID,
				source_fingerprint: AGENT_SOURCE_FINGERPRINTS.get(name)!,
				registered_names: Object.freeze([name]),
			}),
		),
	),
	executable_provenance: INTERNAL_EXECUTABLE_PROVENANCE,
	defaults: INTERNAL_DESCRIPTOR_DEFAULTS,
});

export const INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT = computeDescriptorFingerprint(INTERNAL_PROVIDER_DESCRIPTOR);

declare const internalProviderActivationCapabilityBrand: unique symbol;

/**
 * Opaque host-issued admission capability for this provider.  Its witness is
 * retained in a private WeakMap; a structurally similar object cannot select
 * a root, marker set, inventory authority or registry.
 */
export interface InternalProviderActivationCapability {
	readonly [internalProviderActivationCapabilityBrand]: "InternalProviderActivationCapability";
}

interface InternalProviderActivationWitness {
	readonly registry: ProviderRegistry;
	readonly markerCapability: WorkspaceMarkerCapability;
	readonly resolveInventory: (context: AgentInventoryAuthorityContext) => DiagnosticResult<ActualAgentInventory>;
	readonly inventoryContext: AgentInventoryAuthorityContext;
}

const issuedInternalProviderActivationCapabilities = new WeakMap<object, InternalProviderActivationWitness>();

/**
 * Test-only seam.  It is intentionally omitted from the package barrel.  A
 * production launcher must obtain the equivalent capability from its
 * host-owned admission boundary rather than minting one from repository data.
 */
export function createTestInternalProviderActivationCapability(input: {
	readonly registry: ProviderRegistry;
	readonly markerCapability: WorkspaceMarkerCapability;
	readonly inventoryAuthority: AgentInventoryAuthority;
	readonly inventoryContext: AgentInventoryAuthorityContext;
}): InternalProviderActivationCapability {
	if (!input || typeof input !== "object") throw new TypeError("activation capability input is required");
	if (!input.registry || typeof input.registry !== "object") throw new TypeError("a host provider registry is required");
	const markerRoot = workspaceMarkerRoot(input.markerCapability);
	if (!markerRoot) throw new TypeError("a host-pinned marker capability is required");
	if (
		!input.inventoryAuthority
		|| typeof input.inventoryAuthority !== "object"
		|| typeof input.inventoryAuthority.resolve !== "function"
	) {
		throw new TypeError("a host OMP inventory authority is required");
	}
	if (!input.inventoryContext || typeof input.inventoryContext !== "object") {
		throw new TypeError("a host-bound inventory context is required");
	}
	if (
		input.inventoryContext.canonical_root !== markerRoot
		|| input.inventoryContext.provider_id !== INTERNAL_PROVIDER_ID
		|| input.inventoryContext.descriptor_fingerprint !== INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT
		|| !validInternalDescriptor(input.inventoryContext.descriptor)
		|| !validInternalCatalog(input.inventoryContext.catalog)
	) {
		throw new TypeError("inventory authority context is not pinned to the internal descriptor and marker root");
	}
	const capability = Object.freeze(Object.create(null)) as InternalProviderActivationCapability;
	issuedInternalProviderActivationCapabilities.set(capability as object, Object.freeze({
		registry: input.registry,
		markerCapability: input.markerCapability,
		resolveInventory: input.inventoryAuthority.resolve.bind(input.inventoryAuthority),
		inventoryContext: Object.freeze({ ...input.inventoryContext }),
	}));
	return capability;
}

export interface InternalProviderActivationOptions {
	/** Opaque host-issued admission proof containing the pinned root/markers. */
	readonly activationCapability?: InternalProviderActivationCapability;
	/** Opaque registry supplied by the host lifecycle. */
	readonly registry?: ProviderRegistry;
}

export type InternalProviderActivationOutcome =
	| {
			readonly ok: true;
			readonly value: ProviderRecord;
			readonly diagnostics: readonly WorkflowV2Diagnostic[];
		}
	| {
			readonly ok: false;
			readonly code: "activation_markers_missing";
			readonly missing: readonly string[];
			readonly diagnostics: readonly WorkflowV2Diagnostic[];
		}
	| {
			readonly ok: false;
			readonly code: "launcher_prerequisites_missing";
			readonly missing: readonly string[];
			readonly diagnostics: readonly WorkflowV2Diagnostic[];
		}
	| {
			readonly ok: false;
			readonly code: "provider_publication_failed";
			readonly diagnostics: readonly WorkflowV2Diagnostic[];
		};

function publicationFailure(_error: unknown): DiagnosticResult<ProviderRecord> {
	return failureResult<ProviderRecord>([
		createDiagnostic({
			code: "ACTIVATION_FAILED",
			operation: "provider.lookup",
			evidence: { field: "provider_publication" },
			remediation: `Publish the fixed immutable ${OMP_INTERNAL_BUNDLE_ID} descriptor/catalog registration through the host-owned provider registry.`,
		}),
	]);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	try {
		return value !== null
			&& typeof value === "object"
			&& !Array.isArray(value)
			&& (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
	} catch {
		return false;
	}
}
function canonicalJson(value: unknown): string {
	if (value === null || typeof value === "string" || typeof value === "boolean" || typeof value === "number") {
		const encoded = JSON.stringify(value);
		if (encoded === undefined) throw new TypeError("inventory contains an unserializable primitive");
		return encoded;
	}
	if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
	if (!isPlainRecord(value)) throw new TypeError("inventory contains a non-serializable value");
	return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}
function effectivePolicyDigest(value: unknown): WorkflowV2Digest | undefined {
	try {
		return `sha256:${createHash("sha256").update(canonicalPolicyJson(value), "utf8").digest("hex")}`;
	} catch {
		return undefined;
	}
}

function inventoryFingerprint(agents: readonly AgentRef[]): `sha256:${string}` {
	return `sha256:${createHash("sha256").update(canonicalJson(agents), "utf8").digest("hex")}`;
}

function validReservation(value: unknown): value is NonNullable<ActualAgentInventory["reservation"]> {
	try {
		if (!isPlainRecord(value) || Object.keys(value).length !== 2) return false;
		return typeof value.reservation_id === "string"
			&& value.reservation_id.length > 0
			&& value.reservation_id.length <= 512
			&& value.reservation_id.trim() === value.reservation_id
			&& /^[A-Za-z0-9@._:/#-]+$/u.test(value.reservation_id)
			&& isWorkflowV2Digest(value.fingerprint);
	} catch {
		return false;
	}
}

function validateActualInventory(value: unknown): DiagnosticResult<ActualAgentInventory> {
	if (!isPlainRecord(value)) {
		return failureResult([diagnosticForField("agent_inventory", "Return one actual OMP inventory record from the host admission authority.")]);
	}
	const required = ["authority", "provider_id", "descriptor_fingerprint", "agents", "inventory_fingerprint", "reservation"];
	if (Object.keys(value).some((key) => !required.includes(key))
		|| required.some((key) => !Object.prototype.hasOwnProperty.call(value, key))) {
		return failureResult([diagnosticForField("agent_inventory", "Return the complete inventory and reservation fields without caller-defined extras.")]);
	}
	if (value.authority !== "omp"
		|| !isProviderId(value.provider_id)
		|| value.provider_id !== INTERNAL_PROVIDER_ID
		|| !isWorkflowV2Digest(value.descriptor_fingerprint)
		|| value.descriptor_fingerprint !== INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT
		|| !Array.isArray(value.agents)
		|| !isWorkflowV2Digest(value.inventory_fingerprint)
		|| !validReservation(value.reservation)) {
		return failureResult([diagnosticForField("agent_inventory", "Provide an actual OMP inventory with this descriptor identity and a non-empty reservation.")]);
	}

	const preflight = preflightAgentInventory(value.agents);
	if (!preflight.ok) return preflight;
	const internalAgents = preflight.value.filter((agent) => agent.provider_id === INTERNAL_PROVIDER_ID);
	if (internalAgents.length === 0) {
		return failureResult([diagnosticForField("agent_inventory.agents", "The actual OMP inventory must contain at least one agent from this provider source set.")]);
	}
	const selected = validateProviderAgentInventory(INTERNAL_PROVIDER_DESCRIPTOR, internalAgents);
	if (!selected.ok) return selected;
	let expectedFingerprint: `sha256:${string}`;
	try {
		expectedFingerprint = inventoryFingerprint(preflight.value);
	} catch {
		return failureResult([diagnosticForField("agent_inventory.inventory_fingerprint", "Recompute the bounded inventory fingerprint from the exact observed agent identities.")]);
	}
	if (expectedFingerprint !== value.inventory_fingerprint) {
		return failureResult([diagnosticForField("agent_inventory.inventory_fingerprint", "Use the fingerprint issued for the exact current OMP inventory.")]);
	}

	return successResult(Object.freeze({
		authority: "omp" as const,
		provider_id: INTERNAL_PROVIDER_ID,
		descriptor_fingerprint: INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
		agents: preflight.value,
		inventory_fingerprint: value.inventory_fingerprint,
		reservation: Object.freeze({
			reservation_id: value.reservation.reservation_id,
			fingerprint: value.reservation.fingerprint,
		}),
	}));
}

function sameAgent(left: AgentRef, right: AgentRef): boolean {
	return left.registered_name === right.registered_name
		&& left.provider_id === right.provider_id
		&& left.source_fingerprint === right.source_fingerprint;
}

function sameAgentInventory(left: readonly AgentRef[], right: readonly AgentRef[]): boolean {
	return left.length === right.length
		&& left.every((candidate) => right.some((observed) => sameAgent(candidate, observed)));
}

function selectedInventoryBound(selected: readonly AgentRef[], actual: ActualAgentInventory): boolean {
	return selected.length > 0
		&& selected.every((candidate) => actual.agents.some((observed) => sameAgent(candidate, observed)));
}

function sameProjectIdentity(left: ProjectIdentity, right: ProjectIdentity): boolean {
	return left.root_instance_id === right.root_instance_id
		&& left.provider_id === right.provider_id
		&& left.descriptor_fingerprint === right.descriptor_fingerprint
		&& left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
		&& left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
		&& left.catalog_content_digest === right.catalog_content_digest
		&& left.config_byte_sha256 === right.config_byte_sha256
		&& left.config_semantic_sha256 === right.config_semantic_sha256
		&& left.session.session_id === right.session.session_id
		&& left.session.lifecycle_id === right.session.lifecycle_id;
}
function sameExecutableProvenance(value: ProviderDescriptor["executable_provenance"]): boolean {
	return value.build_fingerprint === INTERNAL_EXECUTABLE_PROVENANCE.build_fingerprint
		&& value.runtime_fingerprint === INTERNAL_EXECUTABLE_PROVENANCE.runtime_fingerprint;
}

function internalDescriptorFingerprint(value: unknown): WorkflowV2Digest | undefined {
	try {
		const validation = validateProviderDescriptor(value);
		if (!validation.ok) return undefined;
		const descriptor = validation.value;
		if (
			descriptor.id !== INTERNAL_PROVIDER_ID
			|| descriptor.protocol_version !== 2
			|| descriptor.catalog_content_digest !== INTERNAL_PROVIDER_CATALOG.content_digest
			|| !sameExecutableProvenance(descriptor.executable_provenance)
		) {
			return undefined;
		}
		const fingerprint = computeDescriptorFingerprint(descriptor);
		return fingerprint === INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT ? fingerprint : undefined;
	} catch {
		return undefined;
	}
}

function validInternalDescriptor(value: unknown): value is Readonly<ProviderDescriptor> {
	return internalDescriptorFingerprint(value) !== undefined;
}

function internalCatalogContentDigest(value: unknown): WorkflowV2Digest | undefined {
	try {
		const validation = validateProviderCatalog(value);
		if (!validation.ok) return undefined;
		const digest = computeCatalogContentDigest(validation.value);
		return digest === INTERNAL_PROVIDER_CATALOG.content_digest ? digest : undefined;
	} catch {
		return undefined;
	}
}

function validInternalCatalog(value: unknown): value is Readonly<ProviderCatalog> {
	return internalCatalogContentDigest(value) !== undefined;
}

function validInternalAuthorityContext(
	value: unknown,
	context: ProviderRuntimeContext,
): value is Readonly<AgentInventoryAuthorityContext> {
	if (!isPlainRecord(value) || !Object.isFrozen(value)) return false;
	const session = value.session;
	if (
		Object.keys(value).length !== 7
		|| !isPlainRecord(session)
		|| !Object.isFrozen(session)
		|| Object.keys(session).length !== 2
		|| typeof session.session_id !== "string"
		|| session.session_id.length === 0
		|| typeof session.lifecycle_id !== "string"
		|| session.lifecycle_id.length === 0
		|| value.canonical_root !== context.canonical_root
		|| session.session_id !== context.project_identity.session.session_id
		|| session.lifecycle_id !== context.project_identity.session.lifecycle_id
		|| value.provider_id !== INTERNAL_PROVIDER_ID
		|| value.descriptor_fingerprint !== INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT
		|| !validInternalDescriptor(value.descriptor)
		|| !validInternalCatalog(value.catalog)
	) {
		return false;
	}
	const authorityPolicyDigest = effectivePolicyDigest(value.effective_policy);
	const runtimePolicyDigest = effectivePolicyDigest(context.effective_policy);
	return authorityPolicyDigest !== undefined
		&& authorityPolicyDigest === runtimePolicyDigest;
}

/**
 * Validate the project-level admission proof retained by the core runtime
 * boundary.  The actual inventory and reservation are read only from the
 * opaque proof; context-level inventory data is a selected-agent consistency
 * check, never an authority substitute.
 */
function validRuntimeContext(context: ProviderRuntimeContext): ProviderActivationAdmission | undefined {
	try {
		if (!context || typeof context !== "object") return undefined;
		const identity = context.project_identity;
		const identityValidation = validateProjectIdentity(identity);
		const runtimePolicyDigest = effectivePolicyDigest(context.effective_policy);
		if (!identityValidation.ok
			|| !Object.isFrozen(identity)
			|| identity.provider_id !== INTERNAL_PROVIDER_ID
			|| identity.descriptor_fingerprint !== INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT
			|| identity.catalog_content_digest !== INTERNAL_PROVIDER_CATALOG.content_digest
			|| !sameExecutableProvenance(identity.executable_provenance)
			|| !isCanonicalRoot(context.canonical_root)
			|| !validInternalDescriptor(context.descriptor)
			|| !validInternalCatalog(context.catalog)
			|| !isWorkflowV2Digest(context.runtime_key)
			|| projectRuntimeKeyFor(identity) !== context.runtime_key
			|| runtimePolicyDigest === undefined
			|| !Array.isArray(context.agent_inventory)) {
			return undefined;
		}

		const selectedPreflight = preflightAgentInventory(context.agent_inventory);
		if (!selectedPreflight.ok) return undefined;
		const internalAgents = selectedPreflight.value.filter((agent) => agent.provider_id === INTERNAL_PROVIDER_ID);
		const selected = validateProviderAgentInventory(INTERNAL_PROVIDER_DESCRIPTOR, internalAgents);
		if (!selected.ok) return undefined;

		const admission = context.activation_admission;
		if (!admission || typeof admission !== "object") return undefined;
		const actual = validateActualInventory(admission.agent_inventory);
		if (!actual.ok || !selectedInventoryBound(selected.value, actual.value)) return undefined;
		if (!validInternalAuthorityContext(admission.authority_context, context)) return undefined;

		const expected: ProviderActivationAdmissionExpectation = {
			project_identity: identity,
			runtime_key: context.runtime_key,
			canonical_root: context.canonical_root,
			provider_id: INTERNAL_PROVIDER_ID,
			descriptor_fingerprint: INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
			catalog_content_digest: INTERNAL_PROVIDER_CATALOG.content_digest,
			executable_provenance: INTERNAL_PROVIDER_DESCRIPTOR.executable_provenance,
			agent_inventory: actual.value,
			agent_inventory_authority: admission.agent_inventory_authority,
			authority_context: admission.authority_context,
		};
		const checked = validateProviderActivationAdmission(admission, expected);
		return checked.ok ? checked.value : undefined;
	} catch {
		return undefined;
	}
}

const INVALID_ADMISSION_EVIDENCE =
	"internal provider runtime dispatch is fail-closed: the opaque core activation admission does not match the captured project, runtime, inventory or authority pins";

function validDispatchAdmission(
	runtimeProjectIdentity: ProjectIdentity,
	runtimeKey: ProviderRuntimeContext["runtime_key"],
	runtimeCanonicalRoot: ProviderRuntimeContext["canonical_root"],
	runtimeDescriptor: Readonly<ProviderDescriptor>,
	runtimeDescriptorFingerprint: WorkflowV2Digest,
	runtimeCatalogContentDigest: WorkflowV2Digest,
	runtimePolicyDigest: WorkflowV2Digest,
	runtimeAgentInventory: readonly AgentRef[],
	runtimeAdmission: ProviderActivationAdmission,
	input: ValidatedDispatch,
): boolean {
	try {
		const inputDescriptorFingerprint = internalDescriptorFingerprint(input.descriptor);
		const inputCatalogContentDigest = internalCatalogContentDigest(input.catalog);
		const inputPolicyDigest = effectivePolicyDigest(input.effective_policy);
		const semanticPolicy = effectivePolicyFromSnapshot(input.snapshot, input.descriptor);
		const semanticPolicyDigest = semanticPolicy.ok ? effectivePolicyDigest(semanticPolicy.value) : undefined;
		if (
			(input.identity_level !== "project" && input.identity_level !== "run")
			|| !sameProjectIdentity(input.project_identity, runtimeProjectIdentity)
			|| input.runtime_key !== runtimeKey
			|| input.snapshot.root !== runtimeCanonicalRoot
			|| inputDescriptorFingerprint === undefined
			|| inputDescriptorFingerprint !== runtimeDescriptorFingerprint
			|| inputCatalogContentDigest === undefined
			|| inputCatalogContentDigest !== runtimeCatalogContentDigest
			|| inputPolicyDigest === undefined
			|| inputPolicyDigest !== runtimePolicyDigest
			|| semanticPolicyDigest === undefined
			|| semanticPolicyDigest !== inputPolicyDigest
		) {
			return false;
		}

		const selectedPreflight = preflightAgentInventory(input.agent_inventory);
		if (!selectedPreflight.ok) return false;
		const internalAgents = selectedPreflight.value.filter((agent) => agent.provider_id === runtimeProjectIdentity.provider_id);
		const selected = validateProviderAgentInventory(runtimeDescriptor, internalAgents);
		if (!selected.ok || !sameAgentInventory(selected.value, runtimeAgentInventory)) return false;

		const runIdentity = input.identity_level === "run" ? input.run_identity : undefined;
		if (input.identity_level === "run" && runIdentity === undefined) return false;
		if (runIdentity !== undefined && !sameProjectIdentity(runIdentity, runtimeProjectIdentity)) return false;

		const expected: ProviderActivationAdmissionExpectation = {
			project_identity: runtimeProjectIdentity,
			runtime_key: runtimeKey,
			canonical_root: runtimeCanonicalRoot,
			provider_id: runtimeProjectIdentity.provider_id,
			descriptor_fingerprint: runtimeProjectIdentity.descriptor_fingerprint,
			catalog_content_digest: runtimeProjectIdentity.catalog_content_digest,
			executable_provenance: runtimeDescriptor.executable_provenance,
			agent_inventory: runtimeAdmission.agent_inventory,
			agent_inventory_authority: runtimeAdmission.agent_inventory_authority,
			authority_context: runtimeAdmission.authority_context,
			...(runIdentity === undefined ? {} : { run_identity: runIdentity }),
		};
		const checked = validateProviderActivationAdmission(input.activation_admission, expected);
		return checked.ok && checked.value.agent_inventory.reservation !== undefined;
	} catch {
		return false;
	}
}

function failedDispatch(input: ValidatedDispatch, evidence: string): ProviderDispatchResult {
	if (input.identity_level === "run") {
		return Object.freeze({
			identity_level: "run",
			project_identity: input.project_identity,
			run_identity: input.run_identity,
			runtime_key: input.runtime_key,
			status: "failed",
			evidence,
		});
	}
	return Object.freeze({
		identity_level: "project",
		project_identity: input.project_identity,
		runtime_key: input.runtime_key,
		status: "failed",
		evidence,
	});
}

/**
 * Phase-2 runtime boundary.  It validates the exact opaque core admission,
 * descriptor/runtime identity, inventory and OMP reservation, then remains
 * deliberately unavailable until a future host-issued executor is bound by a
 * phase-3 cutover.
 */
function createInternalProviderRuntime(context: ProviderRuntimeContext): ProviderRuntime {
	const admission = validRuntimeContext(context);
	if (!admission) {
		throw new Error("internal provider runtime requires the exact project identity, executable fingerprint, canonical root, inventory reservation and opaque core admission");
	}

	const runtimeProjectIdentity = context.project_identity;
	const runtimeKey = context.runtime_key;
	const runtimeCanonicalRoot = context.canonical_root;
	const runtimeDescriptor = context.descriptor;
	const runtimeAgentInventory = context.agent_inventory;
	const runtimeCatalog = context.catalog;
	const runtimeDescriptorFingerprint = computeDescriptorFingerprint(runtimeDescriptor);
	const runtimeCatalogContentDigest = computeCatalogContentDigest(runtimeCatalog);
	const runtimePolicyDigest = effectivePolicyDigest(context.effective_policy);
	if (runtimePolicyDigest === undefined) {
		throw new Error("internal provider runtime requires a canonical effective policy");
	}

	let stopped = false;
	return Object.freeze({
		dispatch: async (input: ValidatedDispatch): Promise<ProviderDispatchResult> => {
			if (stopped) return failedDispatch(input, "internal provider runtime is unavailable after deterministic shutdown");
			if (!validDispatchAdmission(
				runtimeProjectIdentity,
				runtimeKey,
				runtimeCanonicalRoot,
				runtimeDescriptor,
				runtimeDescriptorFingerprint,
				runtimeCatalogContentDigest,
				runtimePolicyDigest,
				runtimeAgentInventory,
				admission,
				input,
			)) {
				return failedDispatch(input, INVALID_ADMISSION_EVIDENCE);
			}
			return failedDispatch(input, "internal provider runtime is fail-closed until a host-issued exact-fingerprint executor is injected");
		},
		shutdown: (): void => {
			stopped = true;
		},
	});
}

/** The only internal registration; it is never exposed as a caller-supplied activation input. */
const INTERNAL_PROVIDER_REGISTRATION: Readonly<ProviderRegistration> = Object.freeze({
	descriptor: INTERNAL_PROVIDER_DESCRIPTOR,
	descriptor_fingerprint: INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
	catalog: INTERNAL_PROVIDER_CATALOG,
	createRuntime: createInternalProviderRuntime,
});

function isFixedProviderRecord(record: ProviderRecord): boolean {
	try {
		return record.provider_id === INTERNAL_PROVIDER_ID
			&& record.provider_id === INTERNAL_PROVIDER_REGISTRATION.descriptor.id
			&& validInternalDescriptor(record.descriptor)
			&& record.descriptor_fingerprint === INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT
			&& validInternalCatalog(record.catalog)
			&& record.createRuntime === INTERNAL_PROVIDER_REGISTRATION.createRuntime;
	} catch {
		return false;
	}
}
const INVALID_INTERNAL_DESCRIPTOR_FINGERPRINT = `sha256:${"0".repeat(64)}` as ProviderRegistration["descriptor_fingerprint"];

function quarantineMismatchedInternalPublication(registry: ProviderRegistry): DiagnosticResult<ProviderRecord> {
	const quarantine = publishProvider(registry, {
		...INTERNAL_PROVIDER_REGISTRATION,
		descriptor_fingerprint: INVALID_INTERNAL_DESCRIPTOR_FINGERPRINT,
	});
	if (!quarantine.ok) return quarantine;
	return failureResult(createDiagnostic({
		code: "PROVIDER_QUARANTINED",
		operation: "provider.lookup",
		evidence: {
			provider_id: INTERNAL_PROVIDER_ID,
			descriptor_fingerprint: INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
		},
		remediation: "Restart the host lifecycle and publish only the exact internal registration with its canonical runtime factory.",
	}));
}

function fixedRegistrationMismatch(): DiagnosticResult<ProviderRecord> {
	return failureResult([
		createDiagnostic({
			code: "IDENTITY_MISMATCH",
			operation: "provider.lookup",
			evidence: { field: "provider_runtime_factory" },
			remediation: "Restart the host lifecycle and publish only the immutable internal registration with its exact fail-closed runtime factory.",
		}),
	]);
}

function publishFixedInternalProvider(registry: ProviderRegistry): DiagnosticResult<ProviderRecord> {
	try {
		const current = lookupProvider(registry, INTERNAL_PROVIDER_ID);
		if (current.ok && !isFixedProviderRecord(current.value)) {
			return quarantineMismatchedInternalPublication(registry);
		}
		const published = publishProvider(registry, INTERNAL_PROVIDER_REGISTRATION);
		if (!published.ok) return published;
		return isFixedProviderRecord(published.value)
			? published
			: quarantineMismatchedInternalPublication(registry);
	} catch (error) {
		return publicationFailure(error);
	}
}

/** Exact lookup; foreign registrations under this provider id fail closed. */
export function lookupInternalProvider(registry: ProviderRegistry): DiagnosticResult<ProviderRecord> {
	try {
		const result = lookupProvider(registry, INTERNAL_PROVIDER_ID);
		if (!result.ok) return result;
		return isFixedProviderRecord(result.value) ? result : fixedRegistrationMismatch();
	} catch (error) {
		return publicationFailure(error);
	}
}

function diagnosticForField(field: string, remediation: string): WorkflowV2Diagnostic {
	return createDiagnostic({
		code: "CAPABILITY_MISSING",
		operation: "admission",
		evidence: { field },
		remediation,
	});
}

function prerequisiteFailure(missing: readonly string[]): InternalProviderActivationOutcome {
	return {
		ok: false,
		code: "launcher_prerequisites_missing",
		missing: Object.freeze([...missing]),
		diagnostics: Object.freeze(
			missing.map((field) =>
				diagnosticForField(
					field,
					"Supply the host-issued pinned root/marker/admission capability, provider registry and actual OMP inventory reservation before activation.",
				),
			),
		),
	};
}

function inventoryFailure(diagnostics: readonly WorkflowV2Diagnostic[]): InternalProviderActivationOutcome {
	return {
		ok: false,
		code: "launcher_prerequisites_missing",
		missing: Object.freeze(["agent_inventory_reservation"]),
		diagnostics: Object.freeze([...diagnostics]),
	};
}

/**
 * Host-admission-gated publication.  Raw roots, marker paths and runtime
 * factories are intentionally not accepted; publication always uses the one
 * fixed registration above.
 */
export function ensureProviderPublication(
	options: InternalProviderActivationOptions | undefined,
): InternalProviderActivationOutcome {
	if (!options || typeof options !== "object") return prerequisiteFailure(["registry", "activation_capability"]);

	// Keep the breaking cutover explicit: legacy callers cannot smuggle an
	// arbitrary runtime or raw path authority alongside the new capability.
	if (
		Object.prototype.hasOwnProperty.call(options, "root")
		|| Object.prototype.hasOwnProperty.call(options, "createRuntime")
		|| Object.prototype.hasOwnProperty.call(options, "filesystemAuthority")
		|| Object.prototype.hasOwnProperty.call(options, "agentInventoryAuthority")
	) {
		return prerequisiteFailure(["activation_capability"]);
	}
	const missing: string[] = [];

	const registry = options.registry;
	if (!registry) missing.push("registry");
	const capability = options.activationCapability;
	const witness = capability !== null && typeof capability === "object"
		? issuedInternalProviderActivationCapabilities.get(capability)
		: undefined;
	if (missing.length > 0) return prerequisiteFailure(missing);
	if (!registry) return prerequisiteFailure(["registry"]);
	if (!witness) return prerequisiteFailure(["activation_capability"]);
	if (witness.registry !== registry) return prerequisiteFailure(["activation_capability"]);
	const markerRoot = workspaceMarkerRoot(witness.markerCapability);
	if (
		!markerRoot
		|| witness.inventoryContext.canonical_root !== markerRoot
		|| witness.inventoryContext.provider_id !== INTERNAL_PROVIDER_ID
		|| witness.inventoryContext.descriptor_fingerprint !== INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT
		|| !validInternalDescriptor(witness.inventoryContext.descriptor)
		|| !validInternalCatalog(witness.inventoryContext.catalog)
	) {
		return prerequisiteFailure(["activation_capability"]);
	}
	const gate = detectWorkspaceMarkers(witness.markerCapability);
	if (!gate.ok) {
		const missingMarkers = Object.freeze(gate.missing.map((marker) => marker.name));
		return {
			ok: false,
			code: "activation_markers_missing",
			missing: missingMarkers,
			diagnostics: Object.freeze(
				gate.missing.map((marker) =>
					createDiagnostic({
						code: "CAPABILITY_MISSING",
						operation: "admission",
						evidence: { field: marker.name },
						remediation: `Obtain a host-issued pinned workspace marker capability proving '${marker.name}' (${OMP_INTERNAL_ACTIVATION_MARKER}) before publishing the internal provider.`,
					}),
				),
			),
		};
	}

	let inventoryResponse: unknown;
	try {
		inventoryResponse = witness.resolveInventory(witness.inventoryContext);
	} catch {
		return inventoryFailure([
			diagnosticForField("agent_inventory_authority", "The host OMP inventory authority failed; retry only after issuing a fresh reservation."),
		]);
	}
	if (!isPlainRecord(inventoryResponse) || !Array.isArray(inventoryResponse.diagnostics)) {
		return inventoryFailure([
			diagnosticForField("agent_inventory_authority", "The host OMP inventory authority must return a typed diagnostic result."),
		]);
	}
	if (inventoryResponse.ok !== true || !Object.prototype.hasOwnProperty.call(inventoryResponse, "value")) {
		const diagnostics = inventoryResponse.diagnostics as readonly WorkflowV2Diagnostic[];
		return inventoryFailure(
			diagnostics.length > 0
				? diagnostics
				: [diagnosticForField("agent_inventory_authority", "The host OMP inventory reservation was not admitted.")],
		);
	}
	let inventory: DiagnosticResult<ActualAgentInventory>;
	try {
		inventory = validateActualInventory(inventoryResponse.value);
	} catch {
		return inventoryFailure([
			diagnosticForField("agent_inventory", "The host OMP inventory authority returned an unreadable inventory record."),
		]);
	}
	if (!inventory.ok) return inventoryFailure(inventory.diagnostics);

	const publication = publishFixedInternalProvider(registry);
	if (!publication.ok) {
		return {
			ok: false,
			code: "provider_publication_failed",
			diagnostics: publication.diagnostics,
		};
	}
	return publication;
}
