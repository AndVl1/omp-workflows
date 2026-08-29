/**
 * Strict, side-effect-free contracts for the workflow provider v2 host.
 *
 * This module deliberately contains data shapes only. Filesystem access,
 * provider lookup, OMP registration, policy parsing and runtime activation
 * are implemented by the corresponding v2 boundary modules.
 *
 * Identity has two deliberately different levels:
 * - ProjectIdentity is the validated host/provider activation identity. It is
 *   profile-free and therefore is the only input to provider runtime startup.
 * - WorkflowRunIdentity is durable state identity. It extends ProjectIdentity
 *   with one exact catalog ProfileIdentity and a run id.
 */

import type { ModelClassification } from "../engine/run.js";
import type { CheckpointAnswerProof, CheckpointRuleKind, Profile, WorkflowName } from "../engine/types.js";
import type { TrustedFsAuthority } from "./fs-authority.js";

export type { CheckpointAnswerProof, CheckpointRuleKind, ModelClassification, Profile, WorkflowName };

/** A SHA-256 digest encoded with its algorithm prefix. */
export type WorkflowV2Digest = `sha256:${string}`;

/** A package-qualified, provider-owned identifier. */
export type ProviderId = string & { readonly __provider_id: unique symbol };

/** A canonical physical project/worktree root supplied by the root manager. */
export type CanonicalRoot = string & { readonly __canonical_root: unique symbol };

/** The process/session runtime key; it is derived from ProjectIdentity only. */
export type ProjectRuntimeKey = WorkflowV2Digest & { readonly __project_runtime_key: unique symbol };

export type ProviderCapability =
  | "workflow_execution"
  | "cto"
  | "profile_catalog"
  | (string & {});

export type HostCapability =
  | "workflow_registration"
  | "workflow_tools"
  | "config_writer"
  | "provider_dispatch"
  | "typed_diagnostics"
  | "identity_binding";

export interface AgentRef {
  readonly registered_name: string;
  readonly provider_id: ProviderId;
  readonly source_fingerprint: WorkflowV2Digest;
}
export interface AgentInventoryReservation {
  readonly reservation_id: string;
  readonly fingerprint: WorkflowV2Digest;
}

/**
 * Provenance-bearing inventory observed through the trusted OMP seam. The
 * marker is deliberately narrow: core does not synthesize or claim a native
 * reservation implementation.
 */
export interface ActualAgentInventory {
  readonly authority: "omp";
  readonly provider_id: ProviderId;
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly agents: readonly AgentRef[];
  readonly inventory_fingerprint: WorkflowV2Digest;
  readonly reservation?: AgentInventoryReservation;
}

export interface AgentInventoryAuthorityContext {
  readonly canonical_root: CanonicalRoot;
  readonly session: SessionIdentity;
  readonly provider_id: ProviderId;
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly descriptor: Readonly<ProviderDescriptor>;
  readonly catalog: Readonly<ProviderCatalog>;
  readonly effective_policy: Readonly<EffectivePolicy>;
}

export interface AgentInventoryAuthority {
  readonly resolve: (context: AgentInventoryAuthorityContext) => DiagnosticResult<ActualAgentInventory>;
}


export interface AgentSourceFingerprint {
  readonly provider_id: ProviderId;
  readonly source_fingerprint: WorkflowV2Digest;
  readonly registered_names: readonly string[];
}

export interface ExecutableProvenance {
  readonly build_fingerprint: WorkflowV2Digest;
  readonly runtime_fingerprint: WorkflowV2Digest;
}

export interface ProfileIdentity {
  readonly id: string;
  readonly fingerprint: WorkflowV2Digest;
}

/** Session/lifecycle pin carried by the validated project identity. */
export interface SessionIdentity {
  readonly session_id: string;
  readonly lifecycle_id: string;
}

/**
 * Profile-free validated identity for one physical worktree and provider
 * activation. Every member is required; no profile, run selection, or
 * singular source selection belongs here. Provider runtime keys are computed
 * from exactly these pins.
 */
export interface ProjectIdentity {
  readonly root_instance_id: WorkflowV2Digest;
  readonly provider_id: ProviderId;
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly executable_provenance: ExecutableProvenance;
  readonly catalog_content_digest: WorkflowV2Digest;
  readonly config_byte_sha256: WorkflowV2Digest;
  readonly config_semantic_sha256: WorkflowV2Digest;
  readonly session: SessionIdentity;
}

/**
 * Durable identity for one workflow run. It inherits every project/provider
 * pin, adds the exact catalog profile selected at prepare time, and carries a
 * run_id that the runtime validator constrains to a safe ASCII token of at
 * most 128 bytes/chars.
 */
export interface WorkflowRunIdentity extends ProjectIdentity {
  readonly run_id: string;

  readonly profile_identity: ProfileIdentity;
}
/**
 * Host-issued, opaque admission proof for one provider runtime boundary.
 *
 * The payload is intentionally descriptive, but the host keeps an identity
 * ledger for each issued object. Consumers must pass the exact object through
 * the validator; reconstructing the same fields is not an admission.
 */
export interface ProviderActivationAdmission {
  readonly project_identity: ProjectIdentity;
  readonly runtime_key: ProjectRuntimeKey;
  readonly canonical_root: CanonicalRoot;
  readonly provider_id: ProviderId;
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly catalog_content_digest: WorkflowV2Digest;
  readonly executable_provenance: ExecutableProvenance;
  readonly agent_inventory: ActualAgentInventory;
  readonly agent_inventory_authority: AgentInventoryAuthority;
  readonly authority_context: Readonly<AgentInventoryAuthorityContext>;
  readonly run_identity?: WorkflowRunIdentity;
}

/** Exact pins a caller expects from one host-issued admission proof. */
export interface ProviderActivationAdmissionExpectation {
  readonly project_identity: ProjectIdentity;
  readonly runtime_key: ProjectRuntimeKey;
  readonly canonical_root: CanonicalRoot;
  readonly provider_id: ProviderId;
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly catalog_content_digest: WorkflowV2Digest;
  readonly executable_provenance: ExecutableProvenance;
  readonly agent_inventory: ActualAgentInventory;
  readonly agent_inventory_authority: AgentInventoryAuthority;
  readonly authority_context: Readonly<AgentInventoryAuthorityContext>;
  readonly run_identity?: WorkflowRunIdentity;
}

/**
 * Provider-owned defaults. Every member is optional so omission can inherit
 * from a provider's own catalog/default layer; the project policy is the only
 * layer allowed to tombstone a value.
 */
export interface DescriptorDefaults {
  readonly roles?: Readonly<Record<string, AgentRef | null>>;
  readonly scope_map?: readonly ScopeRule[];
  readonly roster_overrides?: readonly RosterOverride[];
  readonly flags?: Readonly<Record<string, boolean>>;
  readonly runtime_classes?: Readonly<Record<string, string | boolean>>;
  readonly ui_classes?: Readonly<Record<string, string | boolean>>;
  readonly design_system?: string | null;
  readonly commands?: CommandPolicy;
  readonly workflow?: WorkflowSelection;
  readonly prompt_context?: Readonly<Record<string, PromptContextEntry>>;
  readonly required_capabilities?: readonly string[];
}

export interface ProviderDescriptor {
  readonly id: ProviderId;
  readonly protocol_version: 2;
  readonly capabilities: readonly ProviderCapability[];
  readonly catalog_content_digest: WorkflowV2Digest;
  readonly agent_sources: readonly AgentSourceFingerprint[];
  readonly executable_provenance: ExecutableProvenance;
  readonly defaults: DescriptorDefaults;
}

export interface ProviderCatalog {
  readonly content_digest: WorkflowV2Digest;
  readonly profiles: readonly CatalogProfile[];
}

export interface CatalogProfile {
  readonly identity: ProfileIdentity;
  readonly profile: Readonly<Profile>;
}

export interface ProviderRegistration {
  readonly descriptor: Readonly<ProviderDescriptor>;
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly catalog: Readonly<ProviderCatalog>;
  readonly createRuntime: ProviderRuntimeFactory;
}

/**
 * Context handed to the host while it validates a project activation. It is
 * intentionally profile-free; a workflow run does not exist yet.
 */
export interface HostActivationContext {
  readonly project_identity: ProjectIdentity;
  readonly runtime_key: ProjectRuntimeKey;
  readonly snapshot: PolicySnapshot;
  readonly binding: BindingSnapshot;
  readonly descriptor: Readonly<ProviderDescriptor>;
  readonly catalog: Readonly<ProviderCatalog>;
  readonly effective_policy: Readonly<EffectivePolicy>;
  readonly agent_inventory: readonly AgentRef[];
  readonly agent_inventory_authority?: ActualAgentInventory["authority"];
  readonly agent_inventory_fingerprint?: WorkflowV2Digest;
  readonly agent_inventory_reservation?: AgentInventoryReservation;
}

/**
 * Provider runtime context is the same project-level activation boundary. A
 * runtime factory never receives a profile as startup identity; dispatches
 * carry a run identity only when a durable workflow has been prepared.
 */
export interface ProviderRuntimeContext {
  readonly project_identity: ProjectIdentity;
  readonly runtime_key: ProjectRuntimeKey;
  readonly canonical_root: CanonicalRoot;
  readonly descriptor: Readonly<ProviderDescriptor>;
  readonly catalog: Readonly<ProviderCatalog>;
  readonly effective_policy: Readonly<EffectivePolicy>;
  readonly agent_inventory: readonly AgentRef[];
  readonly activation_admission: ProviderActivationAdmission;
}

export type ProviderRuntimeFactory = (context: ProviderRuntimeContext) => ProviderRuntime;

export interface ProviderRuntime {
  dispatch(input: ValidatedDispatch): Promise<ProviderDispatchResult>;
  shutdown(): void | Promise<void>;
}

export interface WorkflowPolicy {
  readonly roles: Readonly<Record<string, AgentRef | null>>;
  readonly scope_map: readonly ScopePatch[];
  readonly roster_overrides: readonly RosterPatch[];
  readonly flags: Readonly<Record<string, boolean | null>>;
  readonly runtime_classes: Readonly<Record<string, string | boolean | null>>;
  readonly ui_classes: Readonly<Record<string, string | boolean | null>>;
  readonly design_system: string | null;
  readonly commands: CommandPolicy;
  readonly workflow: WorkflowSelection;
  readonly prompt_context: Readonly<Record<string, PromptContextEntry>>;
  readonly required_capabilities: readonly string[];
}

export interface PolicyDocument {
  readonly schema_version: 2;
  readonly provider: PolicyProviderRef;
  readonly policy: WorkflowPolicy;
}

export interface PolicyProviderRef {
  readonly id: ProviderId;
  readonly protocol_version: 2;
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly catalog_content_digest: WorkflowV2Digest;
}

export interface ScopeRule {
  readonly patterns: readonly string[];
  readonly scope: string;
  readonly dev_agent: AgentRef;
  readonly runtime_class?: string | boolean | null;
  readonly ui_class?: string | boolean | null;
}

export type ScopePatch =
  | { readonly op: "replace"; readonly id: string; readonly rule: ScopeRule }
  | { readonly op: "add"; readonly id: string; readonly rule: ScopeRule; readonly before?: string }
  | { readonly op: "remove"; readonly id: string };

export interface RosterOverride {
  readonly replace?: readonly string[];
  readonly add?: readonly string[];
  readonly remove?: readonly string[];
}

export type RosterPatch =
  | { readonly op: "replace"; readonly id: string; readonly value: RosterOverride }
  | { readonly op: "add"; readonly id: string; readonly value: RosterOverride; readonly before?: string }
  | { readonly op: "remove"; readonly id: string };

export interface CommandPolicy {
  readonly "do-work": FragmentCommand;
  readonly team: { readonly alias_of: "do-work" };
  readonly cto: FragmentCommand;
}

export interface FragmentCommand {
  readonly fragments: readonly PolicyFragment[];
}

export interface PolicyFragment {
  readonly id: string;
  readonly text: string;
  readonly owner: { readonly kind: "project_policy"; readonly source: ".omp/team.config.json" };
}

export type PromptContextEntry =
  | { readonly id: string; readonly type: "text"; readonly value: string }
  | { readonly id: string; readonly type: "enum"; readonly value: string }
  | { readonly id: string; readonly type: "number"; readonly value: number }
  | { readonly id: string; readonly type: "boolean"; readonly value: boolean };

/** Matrix defers profile choice to prepare; fixed carries an exact identity. */
export interface MatrixWorkflowSelection {
  readonly selection: "matrix";
}

export interface FixedWorkflowSelection {
  readonly selection: "fixed";
  readonly profile_identity: ProfileIdentity;
}

export type WorkflowSelection = MatrixWorkflowSelection | FixedWorkflowSelection;

export interface PolicySnapshot {
  readonly root: CanonicalRoot;
  readonly document: Readonly<PolicyDocument>;
  readonly byte_sha256: WorkflowV2Digest;
  readonly semantic_sha256: WorkflowV2Digest;
  readonly byte_length: number;
}

export interface EffectivePolicy {
  readonly provider: PolicyProviderRef;
  readonly roles: Readonly<Record<string, AgentRef>>;
  readonly scope_map: readonly ScopeRule[];
  readonly roster_overrides: readonly RosterOverride[];
  readonly flags: Readonly<Record<string, boolean>>;
  readonly runtime_classes: Readonly<Record<string, string | boolean>>;
  readonly ui_classes: Readonly<Record<string, string | boolean>>;
  readonly design_system: string | null;
  readonly commands: CommandPolicy;
  readonly workflow: WorkflowSelection;
  readonly prompt_context: Readonly<Record<string, PromptContextEntry>>;
  readonly required_capabilities: readonly string[];
}

/** Persisted run context always contains a complete run identity. */
export interface WorkflowStateContext {
  readonly run_identity: WorkflowRunIdentity;
  readonly classification: ModelClassification;
  readonly workflow: WorkflowName;
  readonly stage_cursor: string;
  readonly cursor_epoch: string;
}

/** Input to workflow_prepare; an existing run is supplied only on resume. */
export interface WorkflowPrepareInput {
  readonly project_identity: ProjectIdentity;
  readonly classification: ModelClassification;
  readonly catalog: Readonly<ProviderCatalog>;
  readonly effective_policy: Readonly<EffectivePolicy>;
  readonly agent_inventory: readonly AgentRef[];
  readonly existing_run_identity?: WorkflowRunIdentity;
}

/** Successful prepare has atomically persisted the exact run identity. */
export interface WorkflowPrepareResult {
  readonly run_identity: WorkflowRunIdentity;
  readonly state: WorkflowStateContext;
  readonly selected_profile: Readonly<CatalogProfile>;
  readonly persisted: true;
}

export type DiagnosticSeverity = "error" | "warning" | "info";

export type DiagnosticCode =
  | "ROOT_UNAVAILABLE"
  | "CONFIG_MISSING"
  | "CONFIG_MALFORMED"
  | "UNSUPPORTED_SCHEMA"
  | "UNSAFE_PATH"
  | "BINDING_REQUIRED"
  | "IDENTITY_MISMATCH"
  | "PROVIDER_UNAVAILABLE"
  | "PROVIDER_QUARANTINED"
  | "CAPABILITY_MISSING"
  | "PROFILE_UNAVAILABLE"
  | "AGENT_COLLISION"
  | "OWNER_CONFLICT"
  | "TRANSITION_REQUIRED"
  | "ACTIVATION_FAILED"
  | "TRANSACTION_INCOMPLETE"
  | "MIGRATION_REQUIRED";

export type DiagnosticOperation =
  | "root.resolve"
  | "policy.read"
  | "policy.write"
  | "binding.read"
  | "binding.write"
  | "admission"
  | "provider.lookup"
  | "catalog.validate"
  | "profile.resolve"
  | "agent.preflight"
  | "command.dispatch"
  | "tool.dispatch"
  | "runtime.activate"
  | "runtime.shutdown"
  | "management.list"
  | "management.status"
  | "management.select"
  | "management.create"
  | "management.refresh"
  | "management.migrate"
  | "management.apply";

export type DiagnosticEvidencePrimitive = string | number | boolean | null;
export type DiagnosticEvidenceValue = DiagnosticEvidencePrimitive | readonly string[];

export interface WorkflowV2Diagnostic {
  readonly code: DiagnosticCode;
  readonly operation: DiagnosticOperation;
  readonly severity: DiagnosticSeverity;
  readonly evidence: Readonly<Record<string, DiagnosticEvidenceValue>>;
  readonly remediation: string;
}

export type DiagnosticResult<T> =
  | { readonly ok: true; readonly value: T; readonly diagnostics: readonly WorkflowV2Diagnostic[] }
  | { readonly ok: false; readonly diagnostics: readonly WorkflowV2Diagnostic[] };

/** Profile-free identity pins retained by the root-local binding sidecar. */
export interface BindingValidatedIdentity {
  readonly provider_id: ProviderId;
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly executable_provenance: ExecutableProvenance;
  readonly catalog_content_digest: WorkflowV2Digest;
  readonly config_byte_sha256: WorkflowV2Digest;
  readonly config_semantic_sha256: WorkflowV2Digest;
  readonly session: SessionIdentity;
}

export interface BindingDocument {
  readonly binding_version: 1;
  readonly project_worktree_instance: WorkflowV2Digest;
  readonly last_validated: BindingValidatedIdentity;
}

export interface RootEvidence {
  readonly canonical_root: CanonicalRoot;
  readonly root_device: string;
  readonly root_inode: string;
  readonly git_device: string;
  readonly git_inode: string;
  readonly root_instance_nonce: string;
}

export interface BindingSnapshot {
  readonly root: CanonicalRoot;
  readonly path: string;
  readonly document: Readonly<BindingDocument>;
  readonly byte_sha256: WorkflowV2Digest;
  readonly evidence: RootEvidence;
}

export interface ProjectIdentityInput {
  readonly root_instance_id: WorkflowV2Digest;
  readonly provider_id: ProviderId;
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly executable_provenance: ExecutableProvenance;
  readonly catalog_content_digest: WorkflowV2Digest;
  readonly config_byte_sha256: WorkflowV2Digest;
  readonly config_semantic_sha256: WorkflowV2Digest;
  readonly session: SessionIdentity;
}

export interface WorkflowRunIdentityInput {
  readonly project_identity: ProjectIdentity;
  readonly run_id: string;
  readonly profile_identity: ProfileIdentity;
}

/** Opaque no-follow filesystem identity returned and rechecked by the safe I/O boundary. */
export type PathIdentity = string & { readonly __path_identity: unique symbol };

/** Preconditions for creating a v2 policy when no v2 policy was observed. */
export interface AbsentPolicyPrecondition {
  readonly state: "absent";
  readonly canonical_root: CanonicalRoot;
  readonly worktree_id: WorkflowV2Digest;
  readonly session_id: string;
  readonly policy_path: string;
  readonly parent_path_identity: PathIdentity;
  readonly expected_exclusive_create: true;
}

/** Preconditions for changing an existing v2 policy. */
export interface PresentPolicyPrecondition {
  readonly state: "present";
  readonly project_identity: ProjectIdentity;
  readonly policy_path: string;
  readonly policy_file_identity: PathIdentity;
  readonly raw_hash: WorkflowV2Digest;
  readonly semantic_hash: WorkflowV2Digest;
}

export type PolicyPrecondition = AbsentPolicyPrecondition | PresentPolicyPrecondition;

export interface HostDescriptor {
  readonly host_id: string;
  readonly host_version: string;
  readonly protocol_version: 2;
  readonly canonical_commands: readonly ["do-work", "team", "cto", "workflow-provider", "init-team"];
  readonly workflow_tools: readonly ["workflow_prepare", "workflow_begin", "workflow_status", "workflow_instructions", "workflow_complete", "workflow_checkpoint", "workflow_advance"];
  readonly capabilities: readonly HostCapability[];
}

export interface WorkflowHostOptions {
  readonly registry: ProviderRegistry;
  readonly admission: AdmissionBridge;
  readonly host: HostDescriptor;
  readonly resolveRoot: (ctx: unknown) => string | undefined;
  readonly resolveSession: (ctx: unknown) => SessionIdentity | undefined;
  /**
   * Optional in the declaration for phase-2 source compatibility, but
   * runtime-required before any provider activation or dispatch side effect.
   */
  readonly agentInventoryAuthority?: AgentInventoryAuthority;
  readonly filesystemAuthority?: TrustedFsAuthority;
}

export interface WorkflowHost {
  readonly descriptor: HostDescriptor;
  shutdown(): void | Promise<void>;
}

export interface AdmissionBridge {
  admitHost(host: HostDescriptor): DiagnosticResult<{ readonly admitted: true; readonly order: number }>;
  assertAdmitted(host_id: string): DiagnosticResult<{ readonly admitted: true }>;
}

export type CanonicalCommandId = "do-work" | "team" | "cto" | "workflow-provider" | "init-team";

export type WorkflowToolName =
  | "workflow_prepare"
  | "workflow_begin"
  | "workflow_status"
  | "workflow_instructions"
  | "workflow_complete"
  | "workflow_checkpoint"
  | "workflow_advance";

export interface InvocationRequest {
  readonly operation: "command" | "tool";
  readonly name: CanonicalCommandId | WorkflowToolName;
  readonly args: unknown;
  readonly context: unknown;
}

interface ValidatedDispatchBase {
  readonly request: InvocationRequest;
  readonly snapshot: PolicySnapshot;
  readonly binding: BindingSnapshot;
  readonly project_identity: ProjectIdentity;
  readonly runtime_key: ProjectRuntimeKey;
  readonly descriptor: Readonly<ProviderDescriptor>;
  readonly catalog: Readonly<ProviderCatalog>;
  readonly effective_policy: Readonly<EffectivePolicy>;
  readonly agent_inventory: readonly AgentRef[];
  readonly activation_admission: ProviderActivationAdmission;
}

/** Initial commands and workflow_prepare are validated at project level. */
export interface ProjectValidatedDispatch extends ValidatedDispatchBase {
  readonly identity_level: "project";
}

/** All post-prepare workflow tools carry the persisted run identity. */
export interface RunValidatedDispatch extends ValidatedDispatchBase {
  readonly identity_level: "run";
  readonly run_identity: WorkflowRunIdentity;
}

export type ValidatedDispatch = ProjectValidatedDispatch | RunValidatedDispatch;

export interface ProjectDispatchResult {
  readonly identity_level: "project";
  readonly project_identity: ProjectIdentity;
  readonly runtime_key: ProjectRuntimeKey;
  readonly status: "succeeded" | "failed" | "pending";
  readonly evidence: string;
}

export interface RunDispatchResult {
  readonly identity_level: "run";
  readonly project_identity: ProjectIdentity;
  readonly run_identity: WorkflowRunIdentity;
  readonly runtime_key: ProjectRuntimeKey;
  readonly status: "succeeded" | "failed" | "pending";
  readonly evidence: string;
}

export type ProviderDispatchResult = ProjectDispatchResult | RunDispatchResult;

export interface ProviderRecord {
  readonly provider_id: ProviderId;
  readonly descriptor: Readonly<ProviderDescriptor>;
  readonly descriptor_fingerprint: WorkflowV2Digest;
  readonly catalog: Readonly<ProviderCatalog>;
  readonly createRuntime: ProviderRuntimeFactory;
}

export interface ProviderQuarantine {
  readonly provider_id: ProviderId;
  readonly reason: DiagnosticCode;
  readonly descriptor_fingerprint: WorkflowV2Digest | null;
}

declare const providerRegistryBrand: unique symbol;

/** Opaque capability; registry state is private to registry.ts. */
export interface ProviderRegistry {
  readonly [providerRegistryBrand]: "ProviderRegistry";
}

export type ProviderLookupResult = DiagnosticResult<ProviderRecord>;
export type PolicyReadResult = DiagnosticResult<PolicySnapshot>;
export type BindingReadResult = DiagnosticResult<BindingSnapshot>;
export type BindingWriteResult = DiagnosticResult<BindingSnapshot>;

export interface RootBoundBindingWrite {
  readonly root: CanonicalRoot;
  readonly document: Readonly<BindingDocument>;
  readonly confirm_root: true;
  readonly expected?: PolicyPrecondition;
  readonly current?: BindingSnapshot | null;
}

export type PolicyFieldValue =
  | string
  | number
  | boolean
  | null
  | readonly PolicyFieldValue[]
  | { readonly [key: string]: PolicyFieldValue };

export interface FieldOperation {
  readonly operation: "add" | "replace" | "remove";
  readonly path: string;
  readonly before?: PolicyFieldValue;
  readonly after?: PolicyFieldValue;
  readonly id?: string;
}

export type ManagementOperation = "list" | "status" | "select" | "create" | "refresh" | "migrate" | "apply";

/** Trusted manager/session context; user management requests carry intent only. */
export interface ManagementContext {
  readonly root: RootEvidence;
  readonly worktree_id: WorkflowV2Digest;
  readonly session: SessionIdentity;
  readonly filesystem_authority?: TrustedFsAuthority;
}

export interface ProviderListRequest {
  readonly operation: "list";
  readonly dry_run?: true;
}

export interface ProviderStatusRequest {
  readonly operation: "status";
  readonly dry_run?: true;
}

export interface ProviderSelectRequest {
  readonly operation: "select";
  readonly provider_id: ProviderId;
  readonly confirm_root?: boolean;
  readonly dry_run?: true;
}

export interface ProviderCreateRequest {
  readonly operation: "create";
  readonly provider_id: ProviderId;
  readonly confirm_root: true;
  readonly dry_run?: boolean;
}

export interface ProviderRefreshRequest {
  readonly operation: "refresh";
  readonly provider_id?: ProviderId;
  readonly dry_run?: true;
}

export interface ProviderMigrateRequest {
  readonly operation: "migrate";
  readonly provider_id: ProviderId;
  readonly confirm_root?: boolean;
  readonly dry_run: true;
}

export interface ProviderApplyRequest {
  readonly operation: "apply";
  readonly proposal: ManagementProposal;
  readonly proposal_digest: WorkflowV2Digest;
  readonly confirm_root: true;
  readonly expected: PolicyPrecondition;
  readonly dry_run?: false;
}

export type ProviderManagementRequest =
  | ProviderListRequest
  | ProviderStatusRequest
  | ProviderSelectRequest
  | ProviderCreateRequest
  | ProviderRefreshRequest
  | ProviderMigrateRequest
  | ProviderApplyRequest;

export interface ManagementProposal {
  readonly operation: "select" | "create" | "refresh" | "migrate";
  readonly proposal_digest: WorkflowV2Digest;
  readonly provider: PolicyProviderRef;
  readonly next_policy: Readonly<PolicyDocument>;
  readonly field_operations: readonly FieldOperation[];
  readonly expected: PolicyPrecondition;
}

export interface ManagementResult {
  readonly operation: ManagementOperation;
  readonly diagnostics: readonly WorkflowV2Diagnostic[];
  readonly proposal?: ManagementProposal;
  readonly applied?: boolean;
}

export type ProviderManagementResult = DiagnosticResult<ManagementResult>;

export type WorkflowOwnerKind = "fullstack" | "private_omp" | (string & {});

export interface WorkflowOwnerProvenance {
  readonly package: string;
  readonly entrypoint: string;
  readonly cwd: string;
  readonly config_path?: string;
}

export interface WorkflowOwnerIdentity {
  readonly owner_id: string;
  readonly bundle_id: string;
  readonly owner_kind: WorkflowOwnerKind;
  readonly activation_marker: string;
  readonly host_range: string;
  readonly provenance: WorkflowOwnerProvenance;
}

export interface WorkflowOwnerClaim {
  readonly project_root: CanonicalRoot;
  readonly capability: HostCapability;
  readonly project_runtime_key: ProjectRuntimeKey;
  readonly owner: WorkflowOwnerIdentity;
  readonly project_identity: ProjectIdentity;
}

export type WorkflowOwnerClaimResult =
  | {
      readonly ok: true;
      readonly claim: WorkflowOwnerClaim;
      readonly idempotent: boolean;
      readonly diagnostics: readonly WorkflowV2Diagnostic[];
    }
  | {
      readonly ok: false;
      readonly diagnostics: readonly WorkflowV2Diagnostic[];
      readonly claim?: WorkflowOwnerClaim;
    };
