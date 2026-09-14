import { readFileSync, writeFileSync } from "node:fs";
const path = "packages/core/src/commands/cto.ts";
let source = readFileSync(path, "utf8");
const importAnchor = `import { buildCtoSpecificationMapping, loadTeamDefs } from "../cto/plan.js";`;
const importReplacement = `${importAnchor}\nimport { refreshCtoSpecificationConstitution } from "../cto/gates.js";`;
if (!source.includes(importAnchor)) throw new Error("cto import anchor missing");
source = source.replace(importAnchor, importReplacement);
const old = `  const handoff = loaded.handoff;
  if (expectedDigest !== undefined && handoff.handoff_digest !== expectedDigest) return { ok: false, error: \`handoff digest for \${selection.feature_id} changed since mapping confirmation\` };
  if (!handoff.execution_choices.includes("cto")) return { ok: false, error: \`handoff for \${selection.feature_id} does not explicitly allow CTO execution\` };
  const readiness = evaluateHandoffReadiness(handoff, { current_constitution_binding: workspace.constitution_binding });
  if (!readiness.ok) return { ok: false, error: \`handoff readiness for \${selection.feature_id} failed: \${readiness.error}\` };
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed while reading the implementation handoff" };`;
const next = `  const handoff = loaded.handoff;
  if (expectedDigest !== undefined && handoff.handoff_digest !== expectedDigest) return { ok: false, error: \`handoff digest for \${selection.feature_id} changed since mapping confirmation\` };
  if (!handoff.execution_choices.includes("cto")) return { ok: false, error: \`handoff for \${selection.feature_id} does not explicitly allow CTO execution\` };
  const constitution = refreshCtoSpecificationConstitution(root, workspace, handoff, pinnedRoot);
  if (!constitution.ok) return { ok: false, error: constitution.finding };
  const readiness = evaluateHandoffReadiness(handoff, { current_constitution_binding: constitution.binding });
  if (!readiness.ok) return { ok: false, error: \`handoff readiness for \${selection.feature_id} failed: \${readiness.error}\` };
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed while reading the implementation handoff" };`;
if (!source.includes(old)) throw new Error("loadHandoff readiness block missing");
source = source.replace(old, next);
const precommitNeedle = `  if (record.mapping.status !== "awaiting_confirmation") return blockedExecution([\`mapping is not awaiting confirmation (status '\${record.mapping.status}')\`]);
  let consumed: TeamState;`;
const precommitReplacement = `  if (record.mapping.status !== "awaiting_confirmation") return blockedExecution([\`mapping is not awaiting confirmation (status '\${record.mapping.status}')\`]);
  // Re-read every frozen handoff and the live shared constitution after the
  // interactive answer, immediately before preparing the mapping mutation.
  for (const selection of record.selections) {
    const binding = record.mapping.handoff_bindings.find((candidate) => candidate.feature_id === selection.feature_id);
    if (!binding) return blockedExecution([\`mapping lacks a frozen handoff binding for '\${selection.feature_id}'\`]);
    const live = loadHandoff(root, selection, binding.handoff_digest, pinnedRoot);
    if (!live.ok) return blockedExecution([live.error]);
  }
  let consumed: TeamState;`;
if (!source.includes(precommitNeedle)) throw new Error("confirmation precommit anchor missing");
source = source.replace(precommitNeedle, precommitReplacement);
const dispatchNeedle = `  let readySlices = topologicallyReadySlices(execution.value.state, record.mapping);
  const outcomes: CtoSpecificationFeatureDispatchOutcome[] = []`;
const dispatchReplacement = `  // No claim may be admitted until every selected workspace has passed a
  // fresh live-constitution check after the confirmed mapping was loaded.
  for (const entry of prepared) {
    const constitution = refreshCtoSpecificationConstitution(root, entry.workspace, entry.handoff, pinnedRoot);
    if (!constitution.ok) return blockedExecution([entry.selection.feature_id + \": \" + constitution.finding]);
  }
  let readySlices = topologicallyReadySlices(execution.value.state, record.mapping);
  const outcomes: CtoSpecificationFeatureDispatchOutcome[] = []`;
if (!source.includes(dispatchNeedle)) throw new Error("dispatch preclaim anchor missing");
source = source.replace(dispatchNeedle, dispatchReplacement);
const immediateNeedle = `    handoffForClaim = finalLoaded.handoff;
    if (!pinnedRoot.isStable()) return abortAfterClaimFailure(\`\${entry.selection.feature_id}: project root changed before execution claim admission\`);`;
const immediateReplacement = `    handoffForClaim = finalLoaded.handoff;
    const liveConstitution = refreshCtoSpecificationConstitution(root, finalLoaded.workspace, handoffForClaim, pinnedRoot);
    if (!liveConstitution.ok) return abortAfterClaimFailure(\`\${entry.selection.feature_id}: \${liveConstitution.finding}\`);
    if (!pinnedRoot.isStable()) return abortAfterClaimFailure(\`\${entry.selection.feature_id}: project root changed before execution claim admission\`);`;
if (!source.includes(immediateNeedle)) throw new Error("dispatch immediate refresh anchor missing");
source = source.replace(immediateNeedle, immediateReplacement);
writeFileSync(path, source);
