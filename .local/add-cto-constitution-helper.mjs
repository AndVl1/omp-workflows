import { readFileSync, writeFileSync } from "node:fs";
const path = "packages/core/src/cto/gates.ts";
let source = readFileSync(path, "utf8");
const importAnchor = `import { PinnedProjectRoot } from "../specification/pinned-root.js";`;
const importReplacement = `${importAnchor}\nimport { ensureProjectConstitution, readProjectConstitutionGate } from "../specification/prerequisite.js";\nimport type { ConstitutionBinding } from "../specification/types.js";`;
if (!source.includes(importAnchor)) throw new Error("gate imports anchor missing");
source = source.replace(importAnchor, importReplacement);
const exportAnchor = "export { setCanonicalHandoffReadTestHooks as setCtoGateHandoffReadTestHooks };\n\n";
const helper = [
  "export { setCanonicalHandoffReadTestHooks as setCtoGateHandoffReadTestHooks };",
  "",
  "export type CtoConstitutionRefreshResult =",
  "  | { ok: true; binding: ConstitutionBinding }",
  "  | { ok: false; finding: string };",
  "",
  "/**",
  " * Refresh the shared constitution prerequisite against the live source while",
  " * retaining the selected workspace/handoff binding as the authority. This is",
  " * deliberately performed under the caller's pinned root so drift, missing",
  " * sources, unresolved impact transactions, and unusable revisions fail before",
  " * any CTO mapping, confirmation, claim, or dispatch write.",
  " */",
  "export function refreshCtoSpecificationConstitution(",
  "  root: string,",
  "  workspace: FeatureWorkspace,",
  "  handoff: ImplementationHandoff,",
  "  pinnedRoot: PinnedProjectRoot,",
  "): CtoConstitutionRefreshResult {",
  "  if (!pinnedRoot.isStable()) return { ok: false, finding: \"SPEC_PATH_UNAUTHORIZED: project root changed before live constitution refresh\" };",
  "  const persisted = readProjectConstitutionGate(root, pinnedRoot);",
  "  if (!persisted.ok) return { ok: false, finding: persisted.code + \": \" + persisted.error };",
  "  const gate = ensureProjectConstitution(root, {",
  "    origin_kind: persisted.value.origin_kind,",
  "    origin_run_key: persisted.value.origin_run_key,",
  "    origin_stage: persisted.value.origin_stage,",
  "  }, { feature_id: workspace.feature_id, pinnedRoot });",
  "  if (!gate.ok) return { ok: false, finding: gate.code + \": \" + gate.error };",
  "  if (gate.value.status !== \"usable\" || !gate.value.binding) {",
  "    return { ok: false, finding: \"SPEC_CONSTITUTION_IMPACT_PENDING: live constitution prerequisite is \" + gate.value.status };",
  "  }",
  "  if (constitutionComparable(gate.value.binding) !== constitutionComparable(workspace.constitution_binding)) {",
  "    return { ok: false, finding: \"SPEC_CONSTITUTION_IMPACT_PENDING: live constitution binding does not match workspace \" + workspace.feature_id };",
  "  }",
  "  if (constitutionComparable(gate.value.binding) !== constitutionComparable(handoff.constitution_binding)) {",
  "    return { ok: false, finding: \"SPEC_CONSTITUTION_IMPACT_PENDING: live constitution binding does not match handoff \" + handoff.handoff_id };",
  "  }",
  "  if (!pinnedRoot.isStable()) return { ok: false, finding: \"SPEC_PATH_UNAUTHORIZED: project root changed during live constitution refresh\" };",
  "  return { ok: true, binding: gate.value.binding };",
  "}",
  "",
].join("\n");
if (!source.includes(exportAnchor)) throw new Error("gate helper anchor missing");
source = source.replace(exportAnchor, helper);
const start = source.indexOf("    const readiness = evaluateHandoffReadiness(handoff, { current_constitution_binding: workspace.constitution_binding });");
const end = source.indexOf("    if (findings.length === 0", start);
if (start < 0 || end < 0) throw new Error("preflight readiness anchors missing");
const replacement = [
  "    const constitution = refreshCtoSpecificationConstitution(root, workspace, handoff, pinnedRoot);",
  "    if (!constitution.ok) {",
  "      findings.push(selection.feature_id + \": \" + constitution.finding);",
  "      continue;",
  "    }",
  "    const readiness = evaluateHandoffReadiness(handoff, { current_constitution_binding: constitution.binding });",
  "    if (!readiness.ok) findings.push(`handoff readiness for '${selection.feature_id}': ${readiness.error}`);",
].join("\n");
source = source.slice(0, start) + replacement + source.slice(end);
writeFileSync(path, source);
