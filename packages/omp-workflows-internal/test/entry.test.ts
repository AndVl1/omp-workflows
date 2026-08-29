import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import type {
	ActualAgentInventory,
	AgentInventoryAuthority,
	AgentInventoryAuthorityContext,
	CanonicalRoot,
	PolicyDocument,
	ProviderId,
	ProviderRuntimeContext,
	TrustedFsAuthority,
	ValidatedDispatch,
	WorkflowHostOptions,
	WorkflowV2Digest,
} from "@andvl1/omp-workflows-core";
import {
	buildBindingDocument,
	canonicalPolicyJson,
	createAdmissionBridge,
	createDescriptorRelativeFsAuthority,
	createProviderRegistry,
	listProviders,
	publishProvider,
	readPolicySnapshot,
	registerWorkflowV2Host,
	successResult,
	validateInvocation,
	WORKFLOW_V2_HOST_DESCRIPTOR,
	writeBindingAfterConfirmation,
} from "@andvl1/omp-workflows-core";
import { digestImmutable } from "../../core/src/workflow-v2/descriptor.js";
import { createTestDescriptorRelativeFsAuthority } from "../../core/src/workflow-v2/fs-authority.js";
import ompWorkflowsInternal, * as internal from "../src/index.js";
import {
	createTestInternalProviderActivationCapability,
	INTERNAL_PROVIDER_CATALOG,
	INTERNAL_PROVIDER_DESCRIPTOR,
	INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
	ensureProviderPublication,
	lookupInternalProvider,
	INTERNAL_PROVIDER_ID,
} from "../src/provider.js";
import type {
	InternalProviderActivationCapability,
	InternalProviderActivationOptions,
} from "../src/provider.js";
import { createTestWorkspaceMarkerCapability } from "../src/activation.js";

interface RecordedCommand {
	name: string;
	description?: string;
	handler: (args: string) => Promise<void> | void;
}


interface RecordedTool {
	execute: (...args: unknown[]) => Promise<unknown>;
}

type ActivationOptions = {
	readonly registry: ProviderRegistry;
	readonly activationCapability: InternalProviderActivationCapability;
	readonly inventoryAuthority: AgentInventoryAuthority;
	readonly filesystemAuthority: TrustedFsAuthority;
};
function publicationOptions(options: ActivationOptions): InternalProviderActivationOptions {
	return {
		registry: options.registry,
		activationCapability: options.activationCapability,
	};
}
function makePi() {
	const commands = new Map<string, RecordedCommand>();
	const sent: string[] = [];
	const pi = {
		registerCommand(name: string, options: { description?: string; handler: RecordedCommand["handler"] }) {
			commands.set(name, { name, ...options });
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
	};
	return { pi, commands, sent };
}

function makeHostPi() {
	const commands = new Map<string, RecordedCommand>();
	const tools = new Map<string, RecordedTool>();
	const sent: string[] = [];
	const pi = {
		registerCommand(name: string, options: { description?: string; handler: RecordedCommand["handler"] }) {
			commands.set(name, { name, ...options });
		},
		registerTool(definition: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) {
			tools.set(definition.name, definition);
		},
		sendUserMessage(content: string) {
			sent.push(content);
		},
	};
	return { pi, commands, tools, sent };
}

function markedRoot(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-internal-entry-marked-"));
	writeFileSync(join(root, "package.json"), "{}\n");
	mkdirSync(join(root, "packages", "core"), { recursive: true });
	mkdirSync(join(root, "packages", "fullstack"), { recursive: true });
	return root;
}

function hostRoot(): string {
	const root = markedRoot();
	mkdirSync(join(root, ".omp"));
	mkdirSync(join(root, ".git"));
	return root;
}

function plainRoot(): string {
	return mkdtempSync(join(tmpdir(), "omp-internal-entry-plain-"));
}


function actualInventory(): ActualAgentInventory {
	const agents = Object.freeze(
		INTERNAL_PROVIDER_DESCRIPTOR.agent_sources.flatMap((source) =>
			source.registered_names.map((registered_name) =>
				Object.freeze({
					registered_name,
					provider_id: source.provider_id,
					source_fingerprint: source.source_fingerprint,
				}),
			),
		),
	);
	return Object.freeze({
		authority: "omp" as const,
		provider_id: INTERNAL_PROVIDER_ID,
		descriptor_fingerprint: INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
		agents,
		inventory_fingerprint: digestImmutable(agents),
		reservation: Object.freeze({
			reservation_id: "internal-test-reservation",
			fingerprint: `sha256:${"1".repeat(64)}` as WorkflowV2Digest,
		}),
	});
}

function inventoryContext(root: string): AgentInventoryAuthorityContext {
	return {
		canonical_root: root as CanonicalRoot,
		session: Object.freeze({ session_id: "internal-test-session", lifecycle_id: "internal-test-lifecycle" }),
		provider_id: INTERNAL_PROVIDER_ID,
		descriptor_fingerprint: INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
		descriptor: INTERNAL_PROVIDER_DESCRIPTOR,
		catalog: INTERNAL_PROVIDER_CATALOG,
		effective_policy: {} as never,
	};
}
function activationOptions(
	root: string,
	registry = createProviderRegistry(),
	inventoryAuthority?: AgentInventoryAuthority,
): ActivationOptions {
	const filesystemAuthority = createDescriptorRelativeFsAuthority({
		native: createTestDescriptorRelativeFsAuthority(),
	});
	const markerCapability = createTestWorkspaceMarkerCapability(root, filesystemAuthority);
	const authority = inventoryAuthority ?? {
		resolve: () => successResult(actualInventory()),
	};
	const activationCapability = createTestInternalProviderActivationCapability({
		registry,
		markerCapability,
		inventoryAuthority: authority,
		inventoryContext: inventoryContext(root),
	});
	return { registry, activationCapability, inventoryAuthority: authority, filesystemAuthority };
}

const TEST_SESSION = Object.freeze({
	session_id: "internal-test-session",
	lifecycle_id: "internal-test-lifecycle",
});

const FOREIGN_PROVIDER_ID = "@foreign/internal" as ProviderId;
const INVALID_DESCRIPTOR_DIGEST = `sha256:${"0".repeat(64)}` as WorkflowV2Digest;

function hostPolicy(): PolicyDocument {
	return {
		schema_version: 2,
		provider: {
			id: INTERNAL_PROVIDER_ID,
			protocol_version: 2,
			descriptor_fingerprint: INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
			catalog_content_digest: INTERNAL_PROVIDER_CATALOG.content_digest,
		},
		policy: {
			roles: {},
			scope_map: [],
			roster_overrides: [],
			flags: {},
			runtime_classes: {},
			ui_classes: {},
			design_system: null,
			commands: {
				"do-work": { fragments: [] },
				team: { alias_of: "do-work" },
				cto: { fragments: [] },
			},
			workflow: { selection: "matrix" },
			prompt_context: {},
			required_capabilities: [],
		},
	};
}

function bindHostProject(root: string, options: ActivationOptions): void {
	const document = hostPolicy();
	writeFileSync(join(root, ".omp", "team.config.json"), `${canonicalPolicyJson(document)}\n`, "utf8");
	const snapshot = readPolicySnapshot(root, options.filesystemAuthority);
	assert.equal(snapshot.ok, true);
	if (!snapshot.ok) throw new Error(`test policy setup failed: ${snapshot.diagnostics[0]?.code ?? "unknown"}`);
	const binding = buildBindingDocument(root, {
		provider_id: INTERNAL_PROVIDER_ID,
		descriptor_fingerprint: INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
		executable_provenance: INTERNAL_PROVIDER_DESCRIPTOR.executable_provenance,
		catalog_content_digest: INTERNAL_PROVIDER_CATALOG.content_digest,
		config_byte_sha256: snapshot.value.byte_sha256,
		config_semantic_sha256: snapshot.value.semantic_sha256,
		session: TEST_SESSION,
	}, options.filesystemAuthority);
	assert.equal(binding.ok, true);
	if (!binding.ok) throw new Error(`test binding setup failed: ${binding.diagnostics[0]?.code ?? "unknown"}`);
	const written = writeBindingAfterConfirmation({
		root: root as CanonicalRoot,
		document: binding.value,
		confirm_root: true,
	}, options.filesystemAuthority);
	if (!written.ok) throw new Error(`test binding write failed: ${written.diagnostics[0]?.code ?? "unknown"}`);
	assert.equal(written.ok, true);
}

function hostOptions(root: string, options: ActivationOptions): WorkflowHostOptions {
	return {
		registry: options.registry,
		admission: createAdmissionBridge(),
		host: WORKFLOW_V2_HOST_DESCRIPTOR,
		resolveRoot: () => root,
		resolveSession: () => TEST_SESSION,
		filesystemAuthority: options.filesystemAuthority,
		agentInventoryAuthority: options.inventoryAuthority,
	};
}
function runtimeContextFor(dispatch: ValidatedDispatch): ProviderRuntimeContext {
	return Object.freeze({
		project_identity: dispatch.project_identity,
		runtime_key: dispatch.runtime_key,
		canonical_root: dispatch.snapshot.root,
		descriptor: dispatch.descriptor,
		catalog: dispatch.catalog,
		effective_policy: dispatch.effective_policy,
		agent_inventory: dispatch.agent_inventory,
		activation_admission: dispatch.activation_admission,
	});
}

function cloneProviderData(dispatch: ValidatedDispatch): ValidatedDispatch {
	if (dispatch.identity_level === "run") {
		return Object.freeze({
			...dispatch,
			descriptor: structuredClone(dispatch.descriptor),
			catalog: structuredClone(dispatch.catalog),
			effective_policy: structuredClone(dispatch.effective_policy),
		});
	}
	return Object.freeze({
		...dispatch,
		descriptor: structuredClone(dispatch.descriptor),
		catalog: structuredClone(dispatch.catalog),
		effective_policy: structuredClone(dispatch.effective_policy),
	});
}

test("the extension installs only its non-canonical diagnostic command", () => {
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	assert.deepEqual([...host.commands.keys()], ["omp-workflow-team"]);

	assert.match(host.commands.get("omp-workflow-team")?.name ?? "", /^omp-[a-z0-9-]+$/);
});

test("the diagnostic command never infers a root or activates a provider", async () => {
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	await host.commands.get("omp-workflow-team")?.handler("validate");
	assert.match(host.sent[0] ?? "", /provider publication deferred/);
	assert.match(host.sent[0] ?? "", /launcher_prerequisites_missing/);
});

test("marker gating is an explicit host-pinned capability precondition", () => {
	const options = activationOptions(plainRoot());
	const outcome = ensureProviderPublication(publicationOptions(options));
	assert.equal(outcome.ok, false);
	if (outcome.ok) return;
	assert.equal(outcome.code, "activation_markers_missing");
	assert.ok(outcome.missing.includes("package.json"));
	assert.equal(listProviders(options.registry).length, 0);
});

test("missing host activation capability fails closed before registry publication", () => {
	const registry = createProviderRegistry();
	const outcome = ensureProviderPublication({ registry });
	assert.equal(outcome.ok, false);
	if (outcome.ok) return;
	assert.equal(outcome.code, "launcher_prerequisites_missing");
	assert.deepEqual(outcome.missing, ["activation_capability"]);
	assert.equal(listProviders(registry).length, 0);
});

test("missing actual OMP reservation fails closed before registry publication", () => {
	const registry = createProviderRegistry();
	const authority: AgentInventoryAuthority = {
		resolve: () => successResult({ ...actualInventory(), reservation: undefined } as never),
	};
	const options = activationOptions(markedRoot(), registry, authority);
	const outcome = ensureProviderPublication(publicationOptions(options));
	assert.equal(outcome.ok, false);
	if (outcome.ok) return;
	assert.equal(outcome.code, "launcher_prerequisites_missing");
	assert.deepEqual(outcome.missing, ["agent_inventory_reservation"]);
	assert.equal(listProviders(registry).length, 0);
});

test("arbitrary runtime factories and raw publication inputs cannot activate the provider", () => {
	const options = activationOptions(markedRoot());
	let factoryCalls = 0;
	const outcome = ensureProviderPublication({
		...publicationOptions(options),
		createRuntime: () => {
			factoryCalls += 1;
			throw new Error("arbitrary runtime must never be selected");
		},
	} as never);
	assert.equal(outcome.ok, false);
	if (outcome.ok) return;
	assert.deepEqual(outcome.missing, ["activation_capability"]);
	assert.equal(factoryCalls, 0);
	assert.equal(listProviders(options.registry).length, 0);
	assert.equal("publishInternalProvider" in internal, false);
	assert.equal("createInternalProviderRegistration" in internal, false);
});

test("fixed publication is lazy and exact", () => {
	const options = activationOptions(markedRoot());
	const published = ensureProviderPublication(publicationOptions(options));
	assert.equal(published.ok, true);
	assert.equal(listProviders(options.registry).length, 1);
	const lookup = lookupInternalProvider(options.registry);
	assert.equal(lookup.ok, true);
	if (!lookup.ok) return;
	assert.equal(lookup.value.provider_id, INTERNAL_PROVIDER_ID);
	assert.equal(lookup.value.descriptor.id, INTERNAL_PROVIDER_DESCRIPTOR.id);
	assert.equal(lookup.value.descriptor.catalog_content_digest, INTERNAL_PROVIDER_DESCRIPTOR.catalog_content_digest);
	assert.equal(typeof lookup.value.createRuntime, "function");
	assert.throws(
		() => lookup.value.createRuntime({} as never),
		/exact project identity|executable fingerprint/u,
	);
});

test("publication never claims host capabilities or canonical command/tool ownership", () => {
	const host = makePi();
	ompWorkflowsInternal(host.pi as never);
	assert.deepEqual([...host.commands.keys()], ["omp-workflow-team"]);
	assert.ok(!host.commands.has("do-work"));
	assert.ok(!host.commands.has("team"));
	assert.ok(!host.commands.has("cto"));
	assert.ok(!host.commands.has("workflow-provider"));
	assert.ok(!host.commands.has("init-team"));
});

test("a foreign same-identity runtime factory is rejected and quarantined", () => {
	const registry = createProviderRegistry();
	let foreignFactoryCalls = 0;
	const foreignRegistration: ProviderRegistration = {
		descriptor: INTERNAL_PROVIDER_DESCRIPTOR,
		descriptor_fingerprint: INTERNAL_PROVIDER_DESCRIPTOR_FINGERPRINT,
		catalog: INTERNAL_PROVIDER_CATALOG,
		createRuntime: () => {
			foreignFactoryCalls += 1;
			return {
				dispatch: async () => {
					throw new Error("foreign runtime must never be invoked");
				},
				shutdown() {},
			};
		},
	};
	const prepublished = publishProvider(registry, foreignRegistration);
	assert.equal(prepublished.ok, true);
	if (!prepublished.ok) return;
	assert.notEqual(prepublished.value.descriptor, INTERNAL_PROVIDER_DESCRIPTOR);
	assert.notEqual(prepublished.value.catalog, INTERNAL_PROVIDER_CATALOG);

	const options = activationOptions(markedRoot(), registry);
	const outcome = ensureProviderPublication(publicationOptions(options));
	assert.equal(outcome.ok, false);
	if (outcome.ok) return;
	assert.equal(outcome.code, "provider_publication_failed");
	assert.equal(outcome.diagnostics[0]?.code, "PROVIDER_QUARANTINED");
	assert.equal(listProviders(registry).length, 0);
	const lookup = lookupInternalProvider(registry);
	assert.equal(lookup.ok, false);
	if (!lookup.ok) assert.equal(lookup.diagnostics[0]?.code, "PROVIDER_QUARANTINED");
	assert.equal(foreignFactoryCalls, 0);
});

test("the core host activates and dispatches an internal provider from its cloned record", async () => {
	const root = hostRoot();
	const options = activationOptions(root);
	const published = ensureProviderPublication(publicationOptions(options));
	assert.equal(published.ok, true);
	if (!published.ok) return;
	const lookup = lookupInternalProvider(options.registry);
	assert.equal(lookup.ok, true);
	if (!lookup.ok) return;
	assert.notEqual(lookup.value.descriptor, INTERNAL_PROVIDER_DESCRIPTOR);
	assert.notEqual(lookup.value.catalog, INTERNAL_PROVIDER_CATALOG);

	bindHostProject(root, options);
	const validated = validateInvocation(
		{ operation: "tool", name: "workflow_prepare", args: {}, context: {} },
		hostOptions(root, options),
	);
	assert.equal(validated.ok, true);
	if (!validated.ok) return;
	const runtimeContext = runtimeContextFor(validated.value);
	const foreignIdentity = Object.freeze({
		...runtimeContext.project_identity,
		provider_id: FOREIGN_PROVIDER_ID,
	});
	assert.throws(
		() => lookup.value.createRuntime({ ...runtimeContext, project_identity: foreignIdentity }),
		/exact project identity|executable fingerprint/u,
	);
	const mismatchedCatalog = Object.freeze({
		...runtimeContext.catalog,
		content_digest: INVALID_DESCRIPTOR_DIGEST,
	});
	assert.throws(
		() => lookup.value.createRuntime({ ...runtimeContext, catalog: mismatchedCatalog }),
		/exact project identity|executable fingerprint/u,
	);
	const runtime = lookup.value.createRuntime(runtimeContext);
	const clonedDispatch = cloneProviderData(validated.value);
	assert.notEqual(clonedDispatch.descriptor, validated.value.descriptor);
	assert.notEqual(clonedDispatch.catalog, validated.value.catalog);
	assert.notEqual(clonedDispatch.effective_policy, validated.value.effective_policy);
	const cloneResult = await runtime.dispatch(clonedDispatch);
	assert.equal(cloneResult.status, "failed");
	assert.match(cloneResult.evidence, /fail-closed until/u);

	const tamperedDispatch = Object.freeze({
		...clonedDispatch,
		effective_policy: Object.freeze({
			...clonedDispatch.effective_policy,
			flags: Object.freeze({
				...clonedDispatch.effective_policy.flags,
				tampered: true,
			}),
		}),
	}) as ValidatedDispatch;
	const tamperedResult = await runtime.dispatch(tamperedDispatch);
	assert.equal(tamperedResult.status, "failed");
	assert.match(tamperedResult.evidence, /opaque core activation admission/u);
	runtime.shutdown();

	const extension = makeHostPi();
	const host = registerWorkflowV2Host(extension.pi as never, hostOptions(root, options));
	const command = extension.commands.get("do-work");
	assert.ok(command);
	await command.handler("activate the cloned internal provider");
	assert.equal(extension.sent.length, 1);
	assert.match(extension.sent[0] ?? "", /activate the cloned internal provider/u);

	const prepare = extension.tools.get("workflow_prepare");
	assert.ok(prepare);
	const prepared = await prepare.execute("prepare-1", {}, undefined, undefined, {});
	const serialized = JSON.stringify(prepared) ?? "";
	assert.match(serialized, /"ok":true/u);
	assert.match(serialized, /"status":"failed"/u);
	await host.shutdown();
});
