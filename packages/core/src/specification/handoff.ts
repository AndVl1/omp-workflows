/**
 * Pure executor-neutral handoff freezing and readiness (T050).
 *
 *
 * A handoff is a content-addressed implementation contract. This module does
 * not read clocks, filesystem state, or durable engine state; callers provide
 * the exact approved records and, when needed, the current constitution
 * binding explicitly.
 */
import type {
  CompatibilitySupplement,
  ConstitutionBinding,
  ImplementationHandoff,
  ImportSnapshot,
} from "./types.js";
import {
  canonicalJson,
  checkTraceability,
  compatibilitySupplementContentHash,
  compatibilitySupplementId,
  digestOf,
  isRecord,
  validateCompatibilitySupplement,
  validateConstitutionBinding,
  validateImplementationHandoff,
  validateImportSnapshot,
} from "./validation.js";

/** Input to the pure handoff freezer (derived fields are intentionally absent). */
export type HandoffFreezeInput = Omit<
  ImplementationHandoff,
  "schema_version" | "handoff_id" | "handoff_digest" | "status"
> & {
  /** An existing stable id may be retained when revising a handoff. */
  handoff_id?: string;
};

/** Fresh bindings required to revalidate an imported handoff before dispatch. */
export interface ImportedHandoffBinding {
  /** Fresh exact-byte snapshot captured from the original safe paths. */
  import_snapshot: ImportSnapshot;
  /** Aggregate source hash captured with the fresh snapshot. */
  source_hash: string;
  /** Fresh current constitution binding; bound_at remains audit-only. */
  constitution_binding: ConstitutionBinding;
  /** Exact current supplement, or null when no supplement is selected. */
  supplement?: CompatibilitySupplement | null;
}

/** Explicit current binding information used by readiness evaluation. */
export interface HandoffReadinessContext {
  current_constitution_binding?: ConstitutionBinding | null;
  constitution_impact_verdict?: "affected" | "no_impact";
  /** When supplied for an imported handoff, exact source bindings are rechecked. */
  current_import_binding?: ImportedHandoffBinding | null;
}

/** Stable top-level outcomes for the handoff readiness predicate. */
export type HandoffReadinessCode =
  | "SPEC_HANDOFF_NOT_READY"
  | "SPEC_STALE"
  | "SPEC_CONSTITUTION_CHANGED"
  | "SPEC_CONSTITUTION_IMPACT_PENDING";

/** A deterministic actionable readiness gap. */
export interface HandoffReadinessFinding {
  code: string;
  message: string;
}

/** Result of evaluating whether an exact handoff may be executed. */
export type HandoffReadinessResult =
  | { ok: true; handoff: ImplementationHandoff }
  | {
    ok: false;
    code: HandoffReadinessCode;
    error: string;
    findings: Array<HandoffReadinessFinding>;
  };

/** Exact replays retain the approved handoff; changes produce a new stale projection. */
export type ImportedHandoffRevalidationResult =
  | {
    ok: true;
    status: "unchanged";
    handoff: ImplementationHandoff;
    replayed: true;
    findings: [];
  }
  | {
    ok: false;
    status: "stale";
    code: "SPEC_STALE";
    /** New stale projection; the supplied ready handoff remains untouched history. */
    handoff: ImplementationHandoff;
    previous_handoff: ImplementationHandoff;
    replayed: false;
    requires_revalidation: true;
    requires_reapproval: true;
    findings: HandoffReadinessFinding[];
  };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

/** Constitution comparison excludes `bound_at`, which is audit metadata. */
function constitutionEvidence(binding: ConstitutionBinding): Omit<ConstitutionBinding, "bound_at"> {
  return {
    provider_id: binding.provider_id,
    path: binding.path,
    version: binding.version,
    content_sha256: binding.content_sha256,
    semantic_hash: binding.semantic_hash,
    validation_ref: binding.validation_ref,
  };
}

function sameConstitution(left: ConstitutionBinding, right: ConstitutionBinding): boolean {
  return canonicalJson(constitutionEvidence(left)) === canonicalJson(constitutionEvidence(right));
}

function freezeTree<T>(value: T, seen = new WeakSet<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value as object)) return value;
  seen.add(value as object);
  for (const child of Object.values(value as Record<string, unknown>)) freezeTree(child, seen);
  return Object.freeze(value);
}

function sourceHashForSnapshot(snapshot: ImportSnapshot): string {
  return snapshot.files.length === 1
    ? snapshot.files[0]?.sha256 ?? digestOf([])
    : digestOf(snapshot.files.map((file) => ({
      path: file.path,
      sha256: file.sha256,
      size_bytes: file.size_bytes,
    })));
}

function artifactOf(handoff: ImplementationHandoff, kind: "import_snapshot" | "supplement") {
  return handoff.artifact_versions.filter((artifact) => artifact.kind === kind);
}

function supplementIssues(supplement: CompatibilitySupplement): string[] {
  const validation = validateCompatibilitySupplement(supplement);
  if (!validation.ok) return validation.issues;
  const expectedContentHash = compatibilitySupplementContentHash(supplement);
  const expectedId = compatibilitySupplementId(supplement);
  const issues: string[] = [];
  if (supplement.content_sha256 !== expectedContentHash) issues.push("supplement content hash changed");
  if (supplement.supplement_id !== expectedId) issues.push("supplement identity changed");
  return issues;
}

function addFinding(findings: HandoffReadinessFinding[], code: string, message: string): void {
  // Repeated validator paths are not useful to a caller and make reports
  // noisy; retain first occurrence while preserving deterministic order.
  if (!findings.some((finding) => finding.code === code && finding.message === message)) {
    findings.push({ code, message });
  }
}

function addValidationFindings(findings: HandoffReadinessFinding[], issues: readonly string[]): void {
  for (const issue of issues) addFinding(findings, "SPEC_HANDOFF_INVALID", issue);
}

/**
 * Recompute the canonical content address for a persisted handoff.
 *
 * Identity, schema version, status, and the supplied digest are derived
 * metadata; every semantic field is covered by the digest.
 */
export function canonicalHandoffDigest(handoff: ImplementationHandoff): string {
  const { handoff_id: _id, handoff_digest: _digest, schema_version: _schema, status: _status, ...content } = handoff;
  return digestOf(content);
}

/** Return a stale copy without mutating or discarding the immutable approved handoff. */
export function staleImportedHandoff(handoff: ImplementationHandoff): ImplementationHandoff {
  const stale = clone(handoff);
  stale.status = "stale";
  return freezeTree(stale);
}

/**
 * Compare an imported handoff with freshly captured source, constitution, and
 * supplement bindings. Any mismatch yields a stale projection that the shared
 * readiness/claim gate rejects; exact replays retain the established handoff.
 */
export function revalidateImportedHandoff(
  handoff: ImplementationHandoff,
  current: ImportedHandoffBinding,
): ImportedHandoffRevalidationResult {
  const findings: HandoffReadinessFinding[] = [];
  const structural = validateImplementationHandoff(handoff);
  if (!structural.ok) {
    for (const issue of structural.issues) addFinding(findings, "SPEC_HANDOFF_INVALID", issue);
  }
  if (handoff.source_kind !== "external") {
    addFinding(findings, "SPEC_IMPORT_HANDOFF_REQUIRED", "Import revalidation requires an external handoff");
  }
  if (handoff.status !== "ready") {
    addFinding(
      findings,
      "SPEC_HANDOFF_STALE",
      "A stale or candidate import cannot recover approval without revalidation and reapproval",
    );
  }

  const snapshotValidation = validateImportSnapshot(current.import_snapshot);
  if (!snapshotValidation.ok) {
    for (const issue of snapshotValidation.issues) addFinding(findings, "SPEC_IMPORT_SNAPSHOT_INVALID", issue);
  }
  const snapshotLimits = current.import_snapshot.limits;
  const handoffLimits = handoff.import_limits;
  if (snapshotLimits !== undefined) {
    if (handoffLimits === undefined || canonicalJson(handoffLimits) !== canonicalJson(snapshotLimits)) {
      addFinding(findings, "SPEC_IMPORT_SOURCE_CHANGED", "Persisted import ceilings are missing or do not match the approved snapshot");
    }
  } else if (handoffLimits !== undefined) {
    addFinding(findings, "SPEC_IMPORT_SOURCE_CHANGED", "Persisted import ceilings are bound to a snapshot that predates ceiling persistence");
  }
  const importArtifacts = artifactOf(handoff, "import_snapshot");
  const importArtifact = importArtifacts[0];
  if (importArtifacts.length !== 1 || !importArtifact) {
    addFinding(
      findings,
      "SPEC_IMPORT_BINDING_MISSING",
      "Imported handoff must bind exactly one import snapshot artifact",
    );
  } else {
    if (handoff.import_snapshot_ref !== current.import_snapshot.snapshot_id
      || importArtifact.artifact_id !== current.import_snapshot.snapshot_id) {
      addFinding(
        findings,
        "SPEC_IMPORT_SOURCE_CHANGED",
        "Source snapshot identity or selected safe path set changed",
      );
    }
    if (importArtifact.sha256 !== current.source_hash
      || sourceHashForSnapshot(current.import_snapshot) !== current.source_hash) {
      addFinding(findings, "SPEC_IMPORT_SOURCE_CHANGED", "Source bytes, paths, sizes, or hashes changed");
    }
  }

  const bindingIssues = validateConstitutionBinding(current.constitution_binding);
  for (const issue of bindingIssues) addFinding(findings, "SPEC_IMPORT_CONSTITUTION_INVALID", issue);
  if (bindingIssues.length === 0
    && !sameConstitution(handoff.constitution_binding, current.constitution_binding)) {
    addFinding(findings, "SPEC_CONSTITUTION_CHANGED", "Imported handoff constitution binding changed");
  }

  const supplement = current.supplement ?? null;
  const supplementArtifacts = artifactOf(handoff, "supplement");
  const boundSupplementRef = handoff.compatibility_supplement_ref;
  if (supplement === null) {
    if (boundSupplementRef !== null || supplementArtifacts.length !== 0) {
      addFinding(findings, "SPEC_IMPORT_SUPPLEMENT_CHANGED", "Previously approved supplement is missing");
    }
  } else {
    for (const issue of supplementIssues(supplement)) {
      addFinding(findings, "SPEC_IMPORT_SUPPLEMENT_CHANGED", issue);
    }
    const artifact = supplementArtifacts[0];
    if (supplementArtifacts.length !== 1 || !artifact
      || boundSupplementRef !== supplement.supplement_id
      || artifact.artifact_id !== supplement.supplement_id
      || artifact.sha256 !== supplement.content_sha256
      || supplement.snapshot_ref !== current.import_snapshot.snapshot_id) {
      addFinding(
        findings,
        "SPEC_IMPORT_SUPPLEMENT_CHANGED",
        "Supplement identity, content, approval metadata, or snapshot binding changed",
      );
    }
  }

  if (findings.length === 0) {
    return freezeTree({ ok: true, status: "unchanged", handoff, replayed: true, findings: [] });
  }
  return freezeTree({
    ok: false,
    status: "stale",
    code: "SPEC_STALE",
    handoff: staleImportedHandoff(handoff),
    previous_handoff: handoff,
    replayed: false,
    requires_revalidation: true,
    requires_reapproval: true,
    findings,
  });
}

function addArtifactAmbiguityFindings(
  handoff: ImplementationHandoff,
  findings: HandoffReadinessFinding[],
): void {
  if (!Array.isArray(handoff.artifact_versions)) return;
  const seen = new Set<string>();
  for (const artifact of handoff.artifact_versions) {
    if (!isRecord(artifact) || typeof artifact.kind !== "string") continue;
    if (seen.has(artifact.kind)) {
      addFinding(
        findings,
        "SPEC_HANDOFF_VERSION_AMBIGUOUS",
        `Artifact kind '${artifact.kind}' has more than one current version binding`,
      );
    } else {
      seen.add(artifact.kind);
    }
  }
}

function addTraceabilityFindings(
  handoff: ImplementationHandoff,
  findings: HandoffReadinessFinding[],
): void {
  if (!Array.isArray(handoff.requirements)
    || !Array.isArray(handoff.decisions)
    || !Array.isArray(handoff.tasks)
    || !Array.isArray(handoff.verification)) return;

  // The shared checker is deliberately reused instead of creating another
  // traceability vocabulary. Structural validation above protects this call
  // from malformed records supplied by untyped callers.
  try {
    for (const item of checkTraceability(handoff)) {
      addFinding(findings, item.code, item.message);
    }
  } catch {
    addFinding(findings, "SPEC_HANDOFF_INVALID", "Traceability records are malformed");
  }
}

function readinessError(code: HandoffReadinessCode, findings: HandoffReadinessFinding[]): string {
  const detail = findings.map((finding) => `${finding.code}: ${finding.message}`).join("; ");
  return detail.length > 0 ? `${code}: ${detail}` : code;
}

/**
 * Freeze approved traceability into an executor-neutral handoff.
 *
 * The digest covers every supplied semantic field, including all five
 * traceability families and exact artifact-version records. Audit timestamps
 * are not generated here, and no input object is mutated. Invalid or
 * incomplete approved traceability is rejected rather than silently frozen.
 *
 * @throws Error when the supplied content cannot form a valid ready handoff.
 */
export function freezeImplementationHandoff(input: HandoffFreezeInput): ImplementationHandoff {
  const supplied = clone(input) as HandoffFreezeInput & Partial<Pick<
    ImplementationHandoff,
    "schema_version" | "handoff_digest" | "status"
  >>;
  // Derived fields are stripped at runtime too: JavaScript callers cannot
  // smuggle a caller-selected status or digest into the frozen contract.
  const {
    handoff_id: requestedId,
    schema_version: _schema,
    handoff_digest: _digest,
    status: _status,
    ...content
  } = supplied;
  const handoffDigest = digestOf(content);
  const featureId = typeof content.feature_id === "string" ? content.feature_id : "invalid-feature";
  const handoff: ImplementationHandoff = {
    ...content,
    schema_version: 1,
    handoff_id: nonEmpty(requestedId) ? requestedId : `${featureId}.handoff.v1`,
    handoff_digest: handoffDigest,
    status: "ready",
  };

  const validation = validateImplementationHandoff(handoff);
  if (!validation.ok) {
    throw new Error(`Cannot freeze invalid implementation handoff: ${validation.issues.join("; ")}`);
  }
  // Duplicate current kinds are ambiguous even when each individual record is
  // structurally valid; fail closed before exposing an executable handoff.
  const kinds = new Set<string>();
  for (const artifact of handoff.artifact_versions) {
    if (kinds.has(artifact.kind)) {
      throw new Error(`Cannot freeze ambiguous artifact version kind '${artifact.kind}'`);
    }
    kinds.add(artifact.kind);
  }
  return handoff;
}

/**
 * Evaluate the one current, fail-closed handoff readiness predicate.
 *
 * Every independently observable gap is returned in `findings`; declared
 * status is only one input and never upgrades incomplete content. Evaluation
 * is deterministic and performs no persistence or mutation.
 */
export function evaluateHandoffReadiness(
  handoff: ImplementationHandoff,
  context: HandoffReadinessContext = {},
): HandoffReadinessResult {
  if (!isRecord(handoff)) {
    const findings = [{ code: "SPEC_HANDOFF_INVALID", message: "$ must be an object" }];
    return {
      ok: false,
      code: "SPEC_HANDOFF_NOT_READY",
      error: readinessError("SPEC_HANDOFF_NOT_READY", findings),
      findings,
    };
  }

  const findings: HandoffReadinessFinding[] = [];
  const structural = validateImplementationHandoff(handoff);
  if (!structural.ok) addValidationFindings(findings, structural.issues);

  // Explicit gates are reported even when strict validation already found a
  // related issue, so callers receive a useful gap for each blocked invariant.
  if (!Array.isArray(handoff.approval_refs) || handoff.approval_refs.length === 0) {
    addFinding(findings, "SPEC_HANDOFF_APPROVALS_MISSING", "Current handoff approvals are missing");
  }
  if (!Array.isArray(handoff.validation_refs) || handoff.validation_refs.length === 0) {
    addFinding(findings, "SPEC_HANDOFF_VALIDATION_MISSING", "Current handoff validation references are missing");
  }
  if (Array.isArray(handoff.open_decisions)) {
    for (const decision of handoff.open_decisions) {
      addFinding(findings, "SPEC_HANDOFF_OPEN_DECISION", `Blocking decision remains open: ${String(decision)}`);
    }
  } else {
    addFinding(findings, "SPEC_HANDOFF_INVALID", "$.open_decisions must be an array");
  }
  addArtifactAmbiguityFindings(handoff, findings);
  addTraceabilityFindings(handoff, findings);

  let constitutionCode: HandoffReadinessCode | null = null;
  const currentBindingSupplied = Object.prototype.hasOwnProperty.call(context, "current_constitution_binding");
  if (currentBindingSupplied) {
    const current = context.current_constitution_binding;
    if (current === null || current === undefined) {
      constitutionCode = "SPEC_CONSTITUTION_CHANGED";
      addFinding(findings, "SPEC_CONSTITUTION_BINDING_MISSING", "Current constitution binding is missing");
    } else {
      const bindingIssues = validateConstitutionBinding(current);
      if (bindingIssues.length > 0) {
        addValidationFindings(findings, bindingIssues.map((issue) => `current_constitution_binding: ${issue}`));
        constitutionCode = "SPEC_CONSTITUTION_CHANGED";
      } else if (isRecord(handoff.constitution_binding)
        && sameConstitution(handoff.constitution_binding, current)) {
        // The exact bound constitution is current; no impact assessment is
        // needed, irrespective of whether stale audit metadata differs.
      } else {
        const impactRef = typeof handoff.constitution_impact_ref === "string"
          && handoff.constitution_impact_ref.trim().length > 0;
        if (!impactRef) {
          constitutionCode = "SPEC_CONSTITUTION_CHANGED";
          addFinding(
            findings,
            "SPEC_CONSTITUTION_CHANGED",
            "The constitution fingerprint changed and has no recorded impact assessment",
          );
        } else if (context.constitution_impact_verdict === "no_impact") {
          // Recorded no-impact evidence preserves the frozen approval.
        } else {
          constitutionCode = "SPEC_CONSTITUTION_IMPACT_PENDING";
          addFinding(
            findings,
            "SPEC_CONSTITUTION_IMPACT_PENDING",
            context.constitution_impact_verdict === "affected"
              ? "The changed constitution affects this handoff"
              : "Constitution impact assessment is pending for the changed binding",
          );
        }
      }
    }
  }

  let importStale = false;
  if (Object.prototype.hasOwnProperty.call(context, "current_import_binding")) {
    const current = context.current_import_binding;
    if (current === null || current === undefined) {
      importStale = true;
      addFinding(
        findings,
        "SPEC_IMPORT_BINDING_MISSING",
        "Fresh imported source bindings are required before dispatch",
      );
    } else {
      const integrity = revalidateImportedHandoff(handoff, current);
      if (!integrity.ok) {
        importStale = true;
        for (const finding of integrity.findings) addFinding(findings, finding.code, finding.message);
      }
    }
  }

  const declaredStatus = typeof handoff.status === "string" ? handoff.status : null;
  let code: HandoffReadinessCode = "SPEC_HANDOFF_NOT_READY";
  if (declaredStatus === "stale" || importStale) code = "SPEC_STALE";
  else if (constitutionCode !== null) code = constitutionCode;

  if (declaredStatus === "candidate") {
    addFinding(findings, "SPEC_HANDOFF_CANDIDATE", "Candidate handoffs are not executable");
  } else if (declaredStatus !== "ready" && declaredStatus !== "stale") {
    addFinding(findings, "SPEC_HANDOFF_INVALID", "Handoff status is not a recognized readiness status");
  }

  if (declaredStatus === "stale") {
    addFinding(findings, "SPEC_HANDOFF_STALE", "This handoff is stale and requires re-approval");
  }

  if (findings.length > 0) {
    return { ok: false, code, error: readinessError(code, findings), findings };
  }
  return { ok: true, handoff };
}
