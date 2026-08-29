/**
 * Workflow-v2 configuration boundary.
 *
 * The tracked `.omp/team.config.json` policy is the sole runtime authority.
 * Legacy `.claude` documents, caller presets, mapping fallbacks and
 * session-seeded defaults are intentionally absent from this module.
 */
/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-core --> */

export {
  canonicalPolicyJson,
  computePolicyByteHash,
  computePolicySemanticHash,
  effectivePolicyFromSnapshot,
  mergePolicy,
  parsePolicyBytes,
  parsePolicyDocument,
  parseStrictJsonValue,
  policyPath,
  readPolicySnapshot,
  writePolicyDocument,
} from "../workflow-v2/policy.js";

export type {
  PolicyWriteRequest,
  PolicyWriteResult,
} from "../workflow-v2/policy.js";

export type {
  EffectivePolicy,
  PolicyDocument,
  PolicyReadResult,
  PolicySnapshot,
  ProviderDescriptor,
  WorkflowV2Digest,
} from "../workflow-v2/types.js";
