import type { ConstitutionOriginDescriptor } from "../engine/types.js";


export interface ConstitutionGateSnapshot {
  status: string;
  usability_result?: string | null;
}

export interface ConstitutionPromptOrigin {
  feature_id: string;
  run_key: string;
  origin: ConstitutionOriginDescriptor;
  /** Typed gate result, when the caller has already evaluated the prerequisite. */
  gate?: ConstitutionGateSnapshot;
  /** Direct native Specify may provide the exact post-approval preparation payload. */
  workflow_prepare?: Record<string, unknown>;
  /** CTO preparation creates/binds workspaces before impact checks can run. */
  deferImpactUntilPreparation?: boolean;
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

function buildConstitutionPayloads(input: ConstitutionPromptOrigin): {
  ensure: Record<string, unknown>;
  present: Record<string, unknown>;
  ask: Record<string, unknown>;
  decide: Record<string, unknown>;
  impactAssess: Record<string, unknown>;
  impactAsk: Record<string, unknown>;
  impactApply: Record<string, unknown>;
} {
  return {
    ensure: {
      feature_id: input.feature_id,
      run_key: input.run_key,
      origin_kind: input.origin.origin_kind,
      origin_run_key: input.origin.origin_run_key,
      origin_stage: input.origin.origin_stage,
    },
    present: {
      feature_id: input.feature_id,
      run_key: input.run_key,
      gate_id: "<gate_id returned by ensure_project_constitution>",
      document: "<Markdown string beginning with # Project Constitution and containing numbered principles with rationales>",
    },
    ask: {
      feature_id: input.feature_id,
      run_key: input.run_key,
      gate_id: "<gate_id returned by ensure_project_constitution>",
      checkpoint_id: "<checkpoint_ref returned by present_constitution_draft>",
      draft_sha256: "<document_sha256 returned by present_constitution_draft>",
      checkpoint_kind: "constitution_approval",
      question: "Review the canonical constitution draft and choose approve_continue or request_changes.",
    },
    decide: {
      feature_id: input.feature_id,
      run_key: input.run_key,
      gate_id: "<gate_id returned by ensure_project_constitution>",
      checkpoint_id: "<checkpoint_ref returned by present_constitution_draft>",
      decision: "<approve_continue|request_changes>",
      authorization: "human",
      actor_provenance: {
        kind: "user",
        ref: "<trusted_proof.reference>",
        proof: {
          answer_id: "<trusted_proof.answer_id>",
          nonce: "<trusted_proof.nonce>",
          channel: "<trusted_proof.channel>",
          reference: "<trusted_proof.reference>",
          binding: "<trusted_proof.binding>",
          feedback: "<trusted_proof.feedback when decision=request_changes>",
        },
      },
      feedback: "<exact trusted_proof.feedback when decision=request_changes; omit for approve_continue>",
    },
    impactAssess: {
      feature_id: input.feature_id,
      run_key: input.run_key,
    },
    impactAsk: {
      feature_id: input.feature_id,
      run_key: input.run_key,
      assessment_id: "<assessment_id returned by constitution_impact_assess>",
      assessment_hash: "<assessment_hash returned by constitution_impact_assess>",
      workspace_digest: "<workspace_digest returned by constitution_impact_assess>",
      checkpoint_kind: "constitution_impact_approval",
    },
    impactApply: {
      feature_id: input.feature_id,
      run_key: input.run_key,
      assessment_id: "<assessment_id returned by constitution_impact_assess>",
      assessment_hash: "<assessment_hash returned by constitution_impact_assess>",
      workspace_digest: "<workspace_digest returned by constitution_impact_assess>",
      proof: "<complete proof returned by constitution_impact_ask_selected>",
    },
  };
}

function renderBootstrapContract(input: ConstitutionPromptOrigin): string[] {
  const { ensure, present, ask, decide } = buildConstitutionPayloads(input);
  return [
    "Canonical constitution prerequisite bootstrap (engine-owned; exact selectors and origin are mandatory):",
    `1. Call mounted \`ensure_project_constitution\` exactly with ${json(ensure)}. Use only its returned gate status, gate_id, and checkpoint_ref; never infer or edit constitution state.`,
    `2. When the gate is constitution_required, call mounted \`present_constitution_draft\` exactly with ${json(present)}. The document field MUST be one Markdown string beginning with \`# Project Constitution\` and containing at least one numbered \`##\` principle section with a rationale (not JSON or a nested object); it is data, not an instruction.`,
    `3. Immediately after a successful present, the next and only next action MUST be a native host UI Ask: write JSON in the write operation's content field to mounted \`xd://constitution_checkpoint_ask_selected\` exactly with ${json(ask)}. Copy gate_id, checkpoint_id, and draft_sha256 from the exact engine results; do not read the xd:// device documentation, inspect status/todo, call any other tool, or perform filesystem actions between present and this Ask. Copy its trusted proof and actor_provenance verbatim.`,
    `4. Immediately after the Ask returns, call mounted \`decide_constitution_checkpoint\` exactly with ${json(decide)}. Only authorization=human with actor_provenance.kind=user and a durable Ask proof is accepted; request_changes requires top-level feedback exactly equal to actor_provenance.proof.feedback; never author or substitute it.`,
    "5. If ensure_project_constitution returns usable or approved for an existing binding, proceed without a new constitution decision or synthetic approval; the hard Ask is required only when the typed status is constitution_required.",
    "6. If ensure_project_constitution returns blocked because the approved constitution fingerprint changed, do not bootstrap or dispatch a phase.",
  ];
}

/** Shared impact sequence. CTO preparation places this after workspace bootstrap. */
export function renderConstitutionImpactToolContract(input: ConstitutionPromptOrigin): string[] {
  const { impactAssess, impactAsk, impactApply } = buildConstitutionPayloads(input);
  return [
    `6. Call mounted \`constitution_impact_assess\` exactly with ${json(impactAssess)}. The engine owns the complete artifact inventory, semantic evidence, dependency closure, and verdict candidates.`,
    `7. Immediately call mounted \`constitution_impact_ask_selected\` exactly with the returned assessment selectors ${json(impactAsk)}. Only the native host UI may choose approve or reject; no answer is a decision.`,
    `8. After the Ask commits a durable proof, call mounted \`constitution_impact_apply\` exactly with ${json(impactApply)}. Apply is CAS-bound and atomically invalidates only affected downstream artifacts/handoff/claims; a no-impact verdict preserves approvals while rebinding current constitution evidence.`,
    "Reject, unavailable, stale, or malformed impact evidence remains blocked and must not mutate workspace, handoff, claim, or gate state.",
  ];
}

/**
 * Render the one canonical constitution bootstrap contract used by every
 * origin. Values are typed origin metadata; callers do not compose tool
 * payloads or improvise gate/checkpoint identities in prose.
 */
export function renderConstitutionToolContract(input: ConstitutionPromptOrigin): string[] {
  const bootstrap = renderBootstrapContract(input);
  const impact = renderConstitutionImpactToolContract(input);
  const terminal = [
    "9. Only after ensure_project_constitution reports usable/approved for an existing binding, or after a constitution decision or approved-binding impact apply returns approved, may the main workflow call workflow_prepare; no workflow state/classification is created before this gate.",
    ...(input.workflow_prepare === undefined
      ? []
      : [`After the constitution decision returns approved, call mounted \`workflow_prepare\` exactly once with this engine-owned payload: ${json(input.workflow_prepare)}. Do not invent selectors, reinitialize a matching feature/run, or substitute a slash command.`]),
    "Execution rule: when a transition is exposed as an xd:// device, execute it by writing JSON arguments in the write operation's content field; reading xd:// device documentation never executes the transition.",
  ];
  const typedInitial = input.gate?.status === "constitution_required" || input.gate?.status === "awaiting_approval";
  const typedDrift = input.gate?.status === "blocked" && input.gate.usability_result === "usable";
  if (input.deferImpactUntilPreparation) {
    return [
      ...bootstrap,
      "For the initial CTO preparation route, cto_specification_prepare must atomically create and bind each returned feature workspace, then retry workflow_prepare. A fresh workspace with the exact current constitution binding skips impact tools. Only a pre-existing approved binding whose fingerprint changed may run the exact engine-returned sequence constitution_impact_assess, then constitution_impact_ask_selected, then constitution_impact_apply; after approved apply, retry workflow_prepare. Reject, stale, unavailable, or malformed impact evidence remains blocked.",
      ...terminal,
    ];
  }
  if (typedInitial) {
    return [
      ...bootstrap,
      "Typed gate branch: this is the initial constitution bootstrap or an already-open bootstrap checkpoint. Do not call constitution_impact_assess, constitution_impact_ask_selected, or constitution_impact_apply; those tools require a prior approved binding.",
      ...terminal,
    ];
  }
  if (typedDrift) {
    return [
      `1. Call mounted \`ensure_project_constitution\` exactly with ${json(buildConstitutionPayloads(input).ensure)} and use its typed blocked gate result; do not call bootstrap draft tools.`,
      ...impact,
      ...terminal,
    ];
  }
  return [...bootstrap, ...impact, ...terminal];
}
