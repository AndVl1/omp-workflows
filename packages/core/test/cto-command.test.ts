/**
 * Core /cto command contract tests: parseCtoEnvelope, buildCtoPrompt,
 * ctoCommand (CommandContext surface). Consumers wire these into their own
 * commands/hooks — the prompt contract must stay stable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildCtoPrompt,
  buildStandbyCtoPrompt,
  buildAmendPrompt,
  parseCtoEnvelope,
  parseCtoSpecificationExecutionSelections,
  renderChannelSection,
  ctoCommand,
  classifyCtoIntent,
} from "@andvl1/omp-workflows-core";
import { MAX_CTO_SPECIFICATION_AGGREGATE_BYTES, MAX_CTO_SPECIFICATION_REQUESTS } from "../src/cto/types.js";

const TEAMS_JSON = [
  {
    id: "kotlin-backend",
    name: "Kotlin Backend",
    scope: ["backend-kotlin"],
    profile: "lightweight",
    lead: "team-lead",
    roster: ["backend-kotlin"],
  },
];

function assertEngineOwnedExecutionPrompt(prompt: string, label: string): void {
  const tools = ["cto_prepare", "cto_preflight", "cto_confirm", "cto_dispatch", "cto_specification_conformance", "workflow_complete_specification_execution", "cto_close_specification_execution_wave"];
  let previous = -1;
  for (const tool of tools) {
    const index = prompt.indexOf(tool);
    assert.ok(index > previous, `${label}: ${tool} follows the prior engine tool`);
    previous = index;
  }
  assert.match(prompt, /exact (?:eligible-only )?descriptor returned in `cto_prepare\.required_next_tool\.arguments`/i, `${label}: preflight consumes the engine-issued eligible descriptor`);
  assert.match(prompt, /excluded (?:selectors|rows)[^\n]*(?:MUST NOT be repeated|never (?:sent|re-enter))[^\n]*cto_preflight/i, `${label}: excluded selectors never re-enter operational preflight`);
  assert.ok(prompt.includes("current user"), `${label}: mapping choices target the current user`);
  assert.ok(prompt.includes("approve_continue"), `${label}: continue is an explicit mapping decision`);
  assert.ok(prompt.includes("engine-issued"), `${label}: proof comes from the engine`);
  assert.match(prompt, /canonical top-level classification[\s\S]*do not send(?: a)? classification(?: field)?[\s\S]*type=FEATURE, complexity=MEDIUM, confidence=HIGH, autonomous=true, workflow=standard/i, `: execution classification is engine-derived and literal`);
  assert.match(prompt, /never invoke [/]do-work[\s\S]*workflow_prepare[\s\S]*team-state\.json[\s\S]*invent PHASE-0/i, "execution prompt must not fall back to generic preparation or fabricated classification");
  assert.match(prompt, /dispatch only its returned admitted_slices[\s\S]*exact returned <!-- omp-cto-slice run=<runId> slice=<sliceId> --> marker[\s\S]*every lead\/worker task/i, "dispatch prompt must use only engine-admitted slices and exact markers");
  assert.ok(prompt.includes("ensure_project_constitution"), `${label}: shared constitution prerequisite tool is explicit`);
  assert.ok(prompt.includes("present_constitution_draft"), `${label}: constitution draft tool is explicit`);
  assert.ok(prompt.includes("constitution_checkpoint_ask_selected"), `${label}: constitution Ask shape is explicit`);
  assert.ok(prompt.includes("decide_constitution_checkpoint"), `${label}: constitution decision tool is explicit`);
  assert.match(prompt, /"origin_kind":"cto_preparation"/, `${label}: CTO origin kind is explicit`);
  assert.match(prompt, /"origin_run_key":"<exact selected run_key>"/, `${label}: origin run is the exact selected run`);
  assert.match(prompt, /"origin_stage":"cto"/, `${label}: CTO origin stage is canonical`);
  assert.match(prompt, /"authorization":"human"/, `${label}: decision authorization is exact`);
  assert.match(prompt, /"actor_provenance":\{"kind":"user"/, `${label}: user provenance is exact`);
  assert.doesNotMatch(prompt, /^\s*(?:Call|Invoke|Run|Use)\s+`workflow_prepare`/im, `${label}: no generic workflow preparation call`);
  assert.doesNotMatch(prompt, /set its `wave_history` record status|clear `active_wave_id`/i, `${label}: direct terminal wave mutation is absent`);
  assert.match(prompt, /cto_close_specification_execution_wave[\s\S]*engine alone performs the terminal wave CAS/i, `${label}: mounted close tool owns terminal wave mutation`);
  assert.match(prompt, /Evidence subject binding is immutable[\s\S]*requirement IDs and acceptance IDs as subject_id/i, "evidence subjects stay bound to frozen handoff subjects");
  assert.ok(prompt.includes("`conformance_evidence-<feature_id>`") && prompt.includes("`quality_gate_evidence-<feature_id>`"), `${label}: canonical ids use the selected feature formula`);
  assert.ok(prompt.includes(".work-state/features/<feature_id>/artifacts/conformance_evidence-<feature_id>.json") && prompt.includes(".work-state/features/<feature_id>/artifacts/quality_gate_evidence-<feature_id>.json"), `${label}: canonical paths are feature-local and repo-relative`);
  assert.match(prompt, /Alternate generic, worker\/role-suffixed, team-suffixed, or other ids and filenames are forbidden/u, `${label}: alternate artifact ids are forbidden`);
  assert.ok(prompt.includes("conformance envelope top-level shape MUST be exactly `{schema_version,artifact_id,entries}`"), `${label}: conformance envelope shape is exact`);
  assert.ok(prompt.includes("quality-gate envelope top-level shape MUST be exactly `{schema_version,artifact_id,gates}`"), `${label}: quality-gate envelope shape is exact`);
  assert.match(prompt, /NEVER add top-level `source_artifact`, `kind`, `source`, or `gate` fields/u, `${label}: extra envelope fields are forbidden`);
  assert.match(prompt, /Leads MUST pass these exact two ids and full paths unchanged to implementation and QA workers/u, `${label}: leads propagate exact artifact refs`);
  assert.match(prompt, /copy that outcome's `lead_contract` object verbatim into the corresponding lead task/u, `${label}: lead receives the exact outcome contract`);
  assert.match(prompt, /Each lead MUST copy the exact `lead_contract` verbatim into every implementation and QA worker task/u, `${label}: workers receive the exact lead contract`);
  assert.match(prompt, /workers MUST NOT read artifacts-schema\.json or infer alternate keys/u, `${label}: workers use the returned contract without schema-file dependency`);
  assert.match(prompt, /Every entry, including nested entries[\s\S]*recorded_at/i, "nested evidence timestamps are required");
  assert.match(prompt, /Timestamp contract[\s\S]*\^\\d\{4\}-\\d\{2\}-\\d\{2\}T\\d\{2\}:\\d\{2\}:\\d\{2\}\\.\\d\{3\}Z\$/i, "timestamp regex is exact UTC milliseconds");
  assert.match(prompt, /valid (?:example )?`?2026-01-01T00:00:00\.000Z`?/i, "timestamp valid example is explicit");
  assert.match(prompt, /invalid[^\n]*30503000Z[^\n]*818575000Z/i, "high-fraction timestamp examples are explicitly invalid");
  assert.match(prompt, /never use shell `?date`?[^\n]*%N[^\n]*new Date\(\)\.toISOString\(\)/i, "timestamp generation is host-portable");
  assert.match(prompt, /No shell\/checksum\/schema\/repository inspection[\s\S]*conformance retry is allowed/i, "fan-in uses returned typed evidence without inspection or retry loops");
  assert.match(prompt, /passing selected feature[\s\S]*immediately call mounted `workflow_complete_specification_execution`/i, "passing matrices complete immediately");
  assert.match(prompt, /blocked\/changed_intent rows[\s\S]*active claims and remediation findings remain isolated/i, "non-passing matrices retain isolated claims");
  assert.match(prompt, /Workers MUST NOT persist an `artifact` wrapper field on conformance entries[\s\S]*engine alone adds that derived wrapper during fan-in/u, `${label}: engine owns conformance artifact wrappers`);
  assert.match(prompt, /Quality-gate findings MUST be objects with exactly `\{code,subject_id,message,evidence_refs\}[\s\S]*evidence_refs` MUST be a string array[\s\S]*never emit a string finding/u, `${label}: quality findings use the runtime object contract`);
  assert.match(prompt, /Review verdict contract[\s\S]*exactly `pass` or `fail`[\s\S]*blocked[\s\S]*review_verdict: fail/u, `${label}: review verdicts are exact enum values`);
  assert.match(prompt, /Identifier contract[\s\S]*EVERY `evidence_id`[\s\S]*EVERY `artifact_id`[\s\S]*\^\[A-Za-z0-9\._-\]\+\$[\s\S]*128 UTF-8 bytes[\s\S]*raw JSON[\s\S]*newlines/u, `${label}: evidence identifiers are opaque bounded slugs`);
  assert.match(prompt, /Canonical bounds contract[\s\S]*1\.\.256[\s\S]*64 evidence_refs[\s\S]*128 findings[\s\S]*2,097,152 bytes[\s\S]*depth is at most 4/u, `${label}: canonical list, byte, and nesting bounds are explicit`);
  assert.match(prompt, /Identity\/digest contract[\s\S]*handoff_digest[\s\S]*64 lowercase hex[\s\S]*execution_claim_id[\s\S]*bindings/u, `${label}: evidence identity and digest bindings are explicit`);
  assert.match(prompt, /Runtime multiset contract[\s\S]*MUST equal[\s\S]*no missing, extra, or duplicate row[\s\S]*Contradictory pass\/fail[\s\S]*changed_intent/u, `${label}: runtime rows use exact multiset and status semantics`);
  assert.match(prompt, /Every CompletionArtifactRef MUST use `schema_status` values only `met` or `failed`[\s\S]*`quality_gate_status` values only `met`, `pending`, or `failed`[\s\S]*legacy `verified` and `pass` values are forbidden/u, `${label}: CompletionArtifactRef enum values are canonical`);
  assert.match(prompt, /Its `sha256` MUST be exactly 64 lowercase hexadecimal characters[\s\S]*path` MUST equal the exact feature-local artifact path/u, `${label}: CompletionArtifactRef digest/path rules are explicit`);
  assert.match(prompt, /Canonical artifact topology is a three-level acyclic DAG/u, `${label}: canonical three-level topology is explicit`);
  assert.match(prompt, /outer `executed_test\.test\.evidence_ref` values are exactly that supporting runtime-envelope ref/u, `${label}: outer tests point to supporting runtime evidence`);
  assert.match(prompt, /Standalone `implementation_evidence-\*` and `runtime_test_evidence-\*` refs outside this typed supporting envelope are forbidden/u, `${label}: standalone nested artifacts are forbidden`);
  assert.match(prompt, /Mandatory CTO result aggregation[\s\S]*cto_close_specification_execution_wave/i, "mixed outcomes always close through CTO aggregation");
  assert.match(prompt, /Worker result contract[\s\S]*not permission to loop/i, "lead results are terminal and bounded");
  if (prompt.includes("cto_specification_conformance")) {
    assert.match(prompt, /exactly one current execution-profile quality gate/i, `${label}: profile gate is explicit`);
    assert.match(prompt, /execution-profile\.<selected workspace profile_hash>/, `${label}: profile gate binds selected workspace profile`);
    assert.match(prompt, /quality_gate_evidence/, `${label}: profile gate evidence artifact is explicit`);
  }
}

test("cto-cmd: natural-language directive sets the hint and stays out of the task", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-ru-"));
  try {
    const envelope = parseCtoEnvelope("действуй автономно: Add OAuth", root);
    assert.equal(envelope.autonomyHint, true);
    assert.equal(envelope.task, "Add OAuth");

    const prompt = buildCtoPrompt(envelope, root);
    assert.ok(prompt.includes("Autonomy hint (leading directive — MECHANICAL, NOT authoritative; routing/migration metadata only): ON"), "natural directive renders hint ON");
    assert.ok(prompt.includes("- Autonomous: true | false (routing/migration input only; NEVER checkpoint permission)"), "PHASE-0 carries the MODEL routing decision, not the parser flag");
    assert.ok(!prompt.includes("`autonomous: true`"), "parser boolean is NOT copied into the persistence contract");

    const lookalike = parseCtoEnvelope("[AUTONOMOUSLY] Add OAuth", root);
    assert.equal(lookalike.autonomyHint, false, "lookalike does not set the hint");
    assert.equal(lookalike.task, "[AUTONOMOUSLY] Add OAuth", "lookalike stays literal");
    const general = buildCtoPrompt(lookalike, root);
    assert.ok(general.includes("Autonomy hint (leading directive — MECHANICAL, NOT authoritative; routing/migration metadata only): OFF"), "lookalike renders mechanical hint OFF");
    assert.ok(general.includes("GENERAL orchestration"), "ordinary work uses the deterministic general CTO route");
    assert.equal(classifyCtoIntent(lookalike).mode, "general");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: parseCtoEnvelope handles prefixes and issue", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-"));
  try {
    const plain = parseCtoEnvelope("Add OAuth issue=#3", root);
    assert.equal(plain.task, "Add OAuth");
    assert.equal(plain.issue, 3);
    assert.equal(plain.autonomyHint, false);

    const auto = parseCtoEnvelope("[AUTONOMOUS] Fix bug issue=#9", root);
    assert.equal(auto.autonomyHint, true);
    assert.equal(auto.task, "Fix bug");
    assert.equal(auto.issue, 9);
    assert.equal(auto.branch, null); // tmpdir is not a git work tree
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto-cmd: issue metadata rejects zero, unsafe, and repeated identifiers before prompting", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-issue-bounds-"));
  try {
    for (const args of ["Fix issue=#0", "Fix issue=#000000000000000", "Fix issue=#1234567890123456", "Fix issue=#9007199254740992", "Fix issue=#1 issue=#2"]) {
      const parsed = parseCtoEnvelope(args, root);
      assert.equal(parsed.issue, null, `${args}: invalid issue must not become metadata`);
      assert.equal(parsed.specificationSelectionError?.code, "CTO_SPEC_ARGUMENT_INVALID", `${args}: invalid issue must surface a parser error`);
      assert.match(parsed.specificationSelectionError?.message ?? "", /issue metadata/u);
    }
    const safe = parseCtoEnvelope("Fix issue=#999999999999999", root);
    assert.equal(safe.issue, 999999999999999);
    assert.equal(safe.specificationSelectionError, undefined);
    const prompt = ctoCommand({ args: "Fix issue=#0", cwd: root, ui: { notify: () => {} } });
    assert.match(prompt, /^ERROR: CTO_SPEC_ARGUMENT_INVALID:/u, "invalid issue metadata must stop before a CTO prompt is built");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test("cto-cmd: repeated specification selectors preserve all four pairs and order", () => {
  const parsed = parseCtoSpecificationExecutionSelections(
    "execute the selected handoffs --spec readable-cto-passing --run-key run-passing --spec readable-cto-blocked --run-key run-blocked --spec readable-cto-stale --run-key run-stale --spec readable-cto-claimed --run-key run-claimed",
  );
  assert.deepEqual(parsed.selections, [
    { feature_id: "readable-cto-passing", run_key: "run-passing" },
    { feature_id: "readable-cto-blocked", run_key: "run-blocked" },
    { feature_id: "readable-cto-stale", run_key: "run-stale" },
    { feature_id: "readable-cto-claimed", run_key: "run-claimed" },
  ]);
  assert.equal(parsed.task, "execute the selected handoffs");

  const envelope = parseCtoEnvelope(
    "execute the selected handoffs --spec readable-cto-passing --run-key run-passing --spec readable-cto-blocked --run-key run-blocked --spec readable-cto-stale --run-key run-stale --spec readable-cto-claimed --run-key run-claimed",
    "/tmp",
  );
  assert.deepEqual(envelope.specificationSelections, parsed.selections);
  assert.equal(envelope.task, parsed.task);
});

test("cto-cmd: malformed and duplicate specification selector pairs are rejected", () => {
  const unpaired = parseCtoSpecificationExecutionSelections("execute --spec readable-cto-passing");
  assert.equal(unpaired.error?.code, "CTO_SPEC_ARGUMENT_INVALID");
  assert.match(unpaired.error?.message ?? "", /paired|followed/u);

  const runWithoutSpec = parseCtoSpecificationExecutionSelections("execute --run-key run-passing");
  assert.equal(runWithoutSpec.error?.code, "CTO_SPEC_ARGUMENT_INVALID");

  const duplicate = parseCtoSpecificationExecutionSelections(
    "execute --spec readable-cto-passing --run-key run-passing --spec readable-cto-passing --run-key run-passing",
  );
  assert.equal(duplicate.error?.code, "CTO_SPEC_SELECTOR_AMBIGUOUS");
  assert.match(duplicate.error?.message ?? "", /duplicate/u);
});
test("cto-cmd: selector parser bounds argv size, selector count, token work, and run-key safety", () => {
  const exact = Array.from({ length: MAX_CTO_SPECIFICATION_REQUESTS }, (_, index) => `--spec feature-${index} --run-key run-${index}`).join(" ");
  const accepted = parseCtoSpecificationExecutionSelections(exact);
  assert.equal(accepted.error, undefined);
  assert.equal(accepted.selections.length, MAX_CTO_SPECIFICATION_REQUESTS);

  const overLimit = parseCtoSpecificationExecutionSelections(`${exact} --spec feature-over --run-key run-over`);
  assert.equal(overLimit.error?.code, "CTO_SPEC_ARGUMENT_INVALID");
  assert.match(overLimit.error?.message ?? "", /at most|64/u);

  const unsafeRun = parseCtoSpecificationExecutionSelections("--spec feature-one --run-key ../escape");
  assert.equal(unsafeRun.error?.code, "CTO_SPEC_ARGUMENT_INVALID");
  assert.match(unsafeRun.error?.message ?? "", /safe bounded run key/u);

  const oversizedArgv = parseCtoSpecificationExecutionSelections("x".repeat(MAX_CTO_SPECIFICATION_AGGREGATE_BYTES + 1));
  assert.equal(oversizedArgv.error?.code, "CTO_SPEC_ARGUMENT_INVALID");
  assert.match(oversizedArgv.error?.message ?? "", /bytes/u);

  const tooManyTokens = parseCtoSpecificationExecutionSelections(Array.from({ length: 10_000 }, () => "task").join(" "));
  assert.equal(tooManyTokens.error?.code, "CTO_SPEC_ARGUMENT_INVALID");
  assert.match(tooManyTokens.error?.message ?? "", /tokens/u);
});

test("cto-cmd: execution prompt renders immutable full selector payload", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-selectors-"));
  try {
    const prompt = buildCtoPrompt(
      parseCtoEnvelope(
        "execute the selected handoffs --spec readable-cto-passing --run-key run-passing --spec readable-cto-blocked --run-key run-blocked --spec readable-cto-stale --run-key run-stale --spec readable-cto-claimed --run-key run-claimed",
        root,
      ),
      root,
    );
    const selectors = '[{"feature_id":"readable-cto-passing","run_key":"run-passing"},{"feature_id":"readable-cto-blocked","run_key":"run-blocked"},{"feature_id":"readable-cto-stale","run_key":"run-stale"},{"feature_id":"readable-cto-claimed","run_key":"run-claimed"}]';
    assert.ok(prompt.includes(`immutable request audit authority`), "prompt names immutable selector audit authority");
    assert.ok(prompt.includes(`first \`cto_prepare\` write MUST carry this exact selector payload`), "first prepare payload contains every pair");
    assert.match(prompt, /Operational preflight MUST use the exact `cto_prepare\.required_next_tool\.arguments` descriptor/iu);
    assert.match(prompt, /excluded selectors.*MUST NOT be repeated in cto_preflight/iu);
    assert.doesNotMatch(prompt, /selecting only the currently-ready subset/iu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});


test("cto-cmd: intent gate makes preparation, execution, and ambiguous routes mutually exclusive", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-intent-"));
  try {
    const preparation = parseCtoEnvelope(
      "prepare specifications for `prep-atlas` and revise its Tasks; facets stay in one workspace",
      root,
    );
    assert.equal(classifyCtoIntent(preparation).mode, "preparation");
    const preparationPrompt = buildCtoPrompt(preparation, root, { sessionId: "runtime-preparation-42" });
    assert.match(preparationPrompt, /engine has already embedded the exact CTO slice marker[\s\S]*copy each task string and the complete envelope byte-for-byte/iu, "preparation dispatch copies the engine-owned exact marker");
    assert.match(preparationPrompt, /Never concatenate, recompute, move, or substitute a marker/u, "preparation prompt forbids model marker construction");
    assert.doesNotMatch(preparationPrompt, /slice=specification-preparation/u, "preparation prompt does not emit a non-authoritative literal slice marker");
    assert.match(preparationPrompt, /Mode: PREPARATION/u);
    assert.match(
      preparationPrompt,
      /For each scheduled feature, revalidate its exact constitution binding with `ensure_project_constitution`/u,
      "scheduled feature constitution revalidation stays on the preparation route",
    );
    assert.ok(
      preparationPrompt.includes(
        'constitution_impact_assess` exactly with {"feature_id":"<exact returned feature_id>","run_key":"<exact returned feature_id run_key>"}',
      ),
      "scheduled feature impact assessment binds the exact returned feature and run",
    );
    assert.match(
      preparationPrompt,
      /"feature_id":"<explicit first-request feature_id>","run_key":"<resident cto_run_id>","origin_kind":"cto_preparation","origin_run_key":"<resident cto_run_id>","origin_stage":"cto"/u,
      "root constitution bootstrap must retain the resident CTO run origin",
    );
    assert.match(preparationPrompt, /native specification workflow/iu);
    assert.match(preparationPrompt, /current-user checkpoint/iu);
    assert.match(preparationPrompt, /workflow_checkpoint_ask_selected.*current-user checkpoint/iu);
    assert.match(preparationPrompt, /Offer exactly `approve_continue`, `request_changes`, and `approve_stop`/iu);
    assert.match(preparationPrompt, /workflow_prepare.*exact returned feature_id\/run_key/iu);
    assert.match(preparationPrompt, /workflow_start_native_specification_phase[\s\S]*workflow_finalize_native_specification_phase[\s\S]*workflow_checkpoint_ask_selected/iu);
    assert.ok(preparationPrompt.includes("complete opaque `preparation_handoff`"), "native start must consume the opaque workflow_prepare handoff");
    assert.ok(preparationPrompt.includes("workflow_prepare.required_next_tool.arguments"), "native start must use the engine-issued descriptor");
    assert.match(preparationPrompt, /workflow_start_native_specification_phase[\s\S]*with all three fields/iu);
    assert.match(preparationPrompt, /Selector-only.*MUST NOT be used/iu);
    assert.match(preparationPrompt, /strictly sequential/iu);
    assert.match(preparationPrompt, /never invoke, gather, delegate, or batch selected Ask calls concurrently/iu);
    assert.match(preparationPrompt, /never fall back to `workflow_checkpoint`/iu);
    assert.match(preparationPrompt, /prepare, dispatch, and finalize concurrently before their human checkpoint/iu);
    assert.match(preparationPrompt, /before opening another feature's Ask/iu);
    assert.match(preparationPrompt, /exact returned `required_next_tool\.arguments` descriptor verbatim/iu);
    assert.match(preparationPrompt, /never construct, edit, omit, or recompute any field/iu);
    assert.match(preparationPrompt, /including rationale, evidence, actor_provenance, subject_binding/iu);
    assert.ok(preparationPrompt.includes("exact task envelope"), "composite dispatch envelope is exact");
    assert.ok(preparationPrompt.includes("{i, context, tasks}"), "composite dispatch envelope has the closed shape");
    assert.ok(preparationPrompt.includes("agent://<exact-child-id>"), "composite reads the exact child result handle");
    assert.ok(preparationPrompt.includes('hub {op:"wait",ids:["<one-or-more-exact-child-ids>"]}'), "composite waits with exact child IDs");
    assert.match(preparationPrompt, /never use a bare wait when multiple native contexts are active/iu);
    assert.ok(preparationPrompt.includes("direct structured worker_result"), "composite consumes the direct structured worker result");
    assert.ok(preparationPrompt.includes("The direct `structured.data` returned by this read is complete"), "direct agent result is complete despite task-card metadata");
    assert.ok(preparationPrompt.includes("Never read `artifact://`, `skill://artifact-spill-transfer`, another skill"), "native preparation forbids spill and skill reads");
    assert.ok(preparationPrompt.includes("An `ok:true` native finalizer result that includes `required_next_tool` is a hard barrier"), "successful native finalization is a hard barrier");
    assert.ok(preparationPrompt.includes("before ANY other read, hub, task, finalizer, skill, or feature work"), "selected Ask must precede all other work");
    const finalizerCompletion = preparationPrompt.indexOf("The composite owns canonical persistence");
    const hardBarrier = preparationPrompt.indexOf("An `ok:true` native finalizer result that includes `required_next_tool`");
    const selectedAsk = preparationPrompt.indexOf("Execute exactly the returned `workflow_finalize_native_specification_phase.required_next_tool.arguments`");
    const advanceAfterAsk = preparationPrompt.indexOf("After each selected Ask returns, immediately execute its exact returned `required_next_tool.arguments` descriptor verbatim; this returned descriptor is `workflow_advance` and MUST execute before resuming the queue");
    assert.ok([finalizerCompletion, hardBarrier, selectedAsk, advanceAfterAsk].every((index) => index >= 0), "native finalizer, hard barrier, selected Ask, and advance directives are rendered");
    assert.ok(finalizerCompletion < hardBarrier && hardBarrier < selectedAsk && selectedAsk < advanceAfterAsk, "native phase order is finalizer, selected Ask, then advance before queue resume");
    assert.match(preparationPrompt, /Offer exactly `approve_continue`[\s\S]*`request_changes`[\s\S]*`approve_stop`/iu);
    assert.doesNotMatch(preparationPrompt, /cto_(?:prepare|preflight|confirm|dispatch)/u);
    assert.doesNotMatch(preparationPrompt, /^\s*(?:write|persist|append|set)\b.*(?:\.work-state\/cto|state\.json|wave)/imu);

    const execution = parseCtoEnvelope(
      "execute the existing ready handoff --spec prep-atlas --run-key spec-atlas-1",
      root,
    );
    assert.equal(classifyCtoIntent(execution).mode, "execution");
    const executionPrompt = buildCtoPrompt(execution, root);
    assert.match(executionPrompt, /Intent gate — EXECUTION/iu);
    assertEngineOwnedExecutionPrompt(executionPrompt, "explicit execution");
    assert.doesNotMatch(executionPrompt, /Mode: PREPARATION/u);

    const general = parseCtoEnvelope("Add OAuth", root);
    assert.equal(classifyCtoIntent(general).mode, "general");
    const generalPrompt = buildCtoPrompt(general, root);
    assert.match(generalPrompt, /GENERAL orchestration/iu);
    assert.match(generalPrompt, /### CTO discipline/iu);
    assert.match(generalPrompt, /### Workflow routing/iu);
    assert.match(generalPrompt, /LECTURE_RESEARCH/iu);
    assert.doesNotMatch(generalPrompt, /Intent gate — EXECUTION/u);
    assert.doesNotMatch(generalPrompt, /cto_(?:prepare|preflight|confirm|dispatch)/u);

    const selectorWithoutAction = parseCtoEnvelope("inspect existing handoff --spec prep-atlas --run-key spec-atlas-1", root);
    assert.equal(classifyCtoIntent(selectorWithoutAction).mode, "ambiguous");
    const mixed = parseCtoEnvelope("prepare specifications and execute ready handoff --spec prep-atlas --run-key spec-atlas-1", root);
    assert.equal(classifyCtoIntent(mixed).mode, "ambiguous");
    const ambiguousPrompt = buildCtoPrompt(selectorWithoutAction, root);
    assert.match(ambiguousPrompt, /intent is ambiguous/iu);
    assert.match(ambiguousPrompt, /Ask the current user/iu);
    assert.doesNotMatch(ambiguousPrompt, /cto_(?:prepare|preflight|confirm|dispatch)/u);
    assert.doesNotMatch(ambiguousPrompt, /^\s*(?:write|persist|append|set)\b.*(?:\.work-state\/cto|state\.json|wave)/imu);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: buildCtoPrompt renders teams from .omp/teams.json", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "teams.json"), JSON.stringify(TEAMS_JSON));
    const prompt = buildCtoPrompt(parseCtoEnvelope("execute ready handoff --spec oauth --run-key run-oauth", root), root);
    assert.ok(prompt.includes("| `kotlin-backend` | Kotlin Backend |"));
    assert.ok(prompt.includes("Escalation ladder"));
    assert.ok(prompt.includes("Wave / slice gate contract"), "wave/slice gate contract section present");
    assert.ok(
      prompt.includes("<!-- omp-cto-slice run=<runId> slice=<sliceId> -->"),
      "exact slice marker literal in the fresh prompt",
    );
    assertEngineOwnedExecutionPrompt(prompt, "buildCtoPrompt");
    assert.ok(prompt.includes("engine-created active") && prompt.includes("specification-execution wave"), "the engine-created wave is required before lead spawn");
    assert.match(prompt, /(?:full|complete) per-slice classification/, "per-slice classification required");
    assert.ok(prompt.includes("matrix-resolved workflow"), "workflow is resolved by the engine matrix");
    assert.ok(prompt.includes("readable non-empty DoD"), "per-slice DoD is validated by the engine");
    assert.ok(prompt.includes("every lead and worker task must"), "engine-admitted marker propagates to every task");
    assert.ok(prompt.includes(".work-state/features/<feature_id>/artifacts/<artifact_id>.json"), "evidence paths are feature-local and repo-relative");
    assert.ok(prompt.includes("filename MUST be `<artifact_id>.json`"), "evidence filenames are bound to artifact ids");
    assert.ok(!prompt.includes(".work-state/artifacts/<team>/"), "team-global artifact roots are forbidden");
    assert.ok(!prompt.includes("runCto"), "no TS engine call remains in the prompt");
    assert.match(prompt, /Do NOT exceed 8 teams or depth 2/iu);
    assert.ok(prompt.includes("Leads never write source"), "lead self-coding forbidden in the contract");
    assert.ok(prompt.includes("self-coding lead"), "CTO must reject self-coding leads");
    assert.ok(prompt.includes("You ARE the orchestrator"), "single-CTO rule in the contract");
    assert.ok(prompt.includes("never spawn a CTO"), "no sub-CTO delegation allowed");
    assert.ok(prompt.includes("resident CTO"), "main-session CTO role in the contract");
    assert.ok(
      prompt.includes("task(agent=cto)") && prompt.includes("task(agent=@cto)"),
      "nested CTO dispatch forbidden in the contract",
    );
    assert.ok(prompt.includes("return to standby"), "CTO returns to standby after the wave");
    assert.ok(prompt.includes("full-feature"), "full-feature available as team sub-profile");
    assert.ok(prompt.includes("debug-cycle"), "bug-fix slices run debug-cycle through the team");
    assert.ok(prompt.includes("Architecture first"), "architecture stage in the contract");
    assert.ok(prompt.includes("api_contract"), "architect produces the cross-team contract");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: buildCtoPrompt includes the COMPLETE workflow matrix (REVIEW/HOTFIX + P5 rule)", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-matrix-"));
  try {
    const prompt = buildCtoPrompt(parseCtoEnvelope("execute ready handoff --spec oauth --run-key run-oauth", root), root);
    assert.ok(prompt.includes("### Workflow routing"), "workflow routing matrix section present");
    assert.ok(prompt.includes("| REVIEW | review | review | review | review |"), "REVIEW row rendered");
    assert.ok(prompt.includes("| HOTFIX | emergency | emergency | emergency | emergency |"), "HOTFIX row rendered");
    assert.ok(prompt.includes("classification.autonomous during migration only"), "P5 re-derives routing from classification.autonomous only during migration");
    assert.ok(prompt.includes("Never re-derive"), "autonomy is never re-derived from task text or markers");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: buildAmendPrompt includes the complete workflow matrix too", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-matrix-amend-"));
  try {
    const prompt = buildAmendPrompt(
      parseCtoEnvelope("execute ready handoff --spec feature-b --run-key run-b", root),
      root,
      { runId: "run-1", state: { plan: { created_at: "2026-08-04T10:00:00.000Z" }, teams: [{ id: "backend", status: "in_progress" }], pause: { kind: "none", reason: "" }, updated_at: "2026-08-04T10:05:00.000Z" } },
    );
    assert.ok(prompt.includes("| REVIEW | review | review | review | review |"), "REVIEW row in amend");
    assert.ok(prompt.includes("| HOTFIX | emergency | emergency | emergency | emergency |"), "HOTFIX row in amend");
    assert.ok(prompt.includes("`conformance_evidence-<feature_id>`") && prompt.includes("`quality_gate_evidence-<feature_id>`"), "amend: canonical ids use the selected feature formula");
    assert.ok(prompt.includes(".work-state/features/<feature_id>/artifacts/conformance_evidence-<feature_id>.json") && prompt.includes(".work-state/features/<feature_id>/artifacts/quality_gate_evidence-<feature_id>.json"), "amend: canonical paths are feature-local and repo-relative");
    assert.match(prompt, /Alternate generic, worker\/role-suffixed, team-suffixed, or other ids and filenames are forbidden/u, "amend: alternate artifact ids are forbidden");
    assert.ok(prompt.includes("conformance envelope top-level shape MUST be exactly `{schema_version,artifact_id,entries}`"), "amend: conformance envelope shape is exact");
    assert.ok(prompt.includes("quality-gate envelope top-level shape MUST be exactly `{schema_version,artifact_id,gates}`"), "amend: quality-gate envelope shape is exact");
    assert.match(prompt, /copy that outcome's `lead_contract` object verbatim into the corresponding lead task/u, "amend: lead receives the exact outcome contract");
    assert.match(prompt, /Each lead MUST copy the exact `lead_contract` verbatim into every implementation and QA worker task/u, "amend: workers receive the exact lead contract");
    assert.match(prompt, /Workers MUST NOT persist an `artifact` wrapper field on conformance entries[\s\S]*engine alone adds that derived wrapper during fan-in/u, "amend: engine owns conformance artifact wrappers");
    assert.match(prompt, /Quality-gate findings MUST be objects with exactly `\{code,subject_id,message,evidence_refs\}[\s\S]*evidence_refs` MUST be a string array[\s\S]*never emit a string finding/u, "amend: quality findings use the runtime object contract");
    assert.match(prompt, /Every CompletionArtifactRef MUST use `schema_status` values only `met` or `failed`[\s\S]*`quality_gate_status` values only `met`, `pending`, or `failed`[\s\S]*legacy `verified` and `pass` values are forbidden/u, "amend: CompletionArtifactRef enum values are canonical");
    assert.match(prompt, /Its `sha256` MUST be exactly 64 lowercase hexadecimal characters[\s\S]*path` MUST equal the exact feature-local artifact path/u, "amend: CompletionArtifactRef digest/path rules are explicit");
    assert.match(prompt, /Canonical artifact topology is a three-level acyclic DAG/u, "amend: canonical three-level topology is explicit");
    assert.match(prompt, /outer `executed_test\.test\.evidence_ref` values are exactly that supporting runtime-envelope ref/u, "amend: outer tests point to supporting runtime evidence");
    assert.match(prompt, /Standalone `implementation_evidence-\*` and `runtime_test_evidence-\*` refs outside this typed supporting envelope are forbidden/u, "amend: standalone nested artifacts are forbidden");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: persistence contract is engine-owned and PHASE-0 classification is model-first", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-persist-"));
  try {
    const prompt = buildCtoPrompt(parseCtoEnvelope("execute ready handoff --spec oauth --run-key run-oauth", root), root);
    assert.ok(prompt.includes("### PHASE 0: INTELLIGENT CLASSIFICATION"), "prompt contains the structured PHASE-0 classification contract");
    assert.ok(prompt.includes("- Autonomous: true | false (routing/migration input only; NEVER checkpoint permission)"), "classification.autonomous is routing input only");
    assert.ok(prompt.includes("### Engine-owned preparation (mandatory)"), "state preparation is engine-owned");
    assert.ok(prompt.includes("Do not write `.work-state/cto`"), "canonical CTO state is not model-written");
    assert.ok(prompt.includes("Do not call a generic workflow preparation tool"), "generic workflow preparation is forbidden");
    assert.ok(!prompt.includes('classification: { "type":'), "old inline persistence wording is gone");
    assert.ok(!prompt.includes("read-compat only"), "legacy persistence wording is gone");
    assert.ok(!prompt.includes("`autonomous: true`"), "parser boolean is never copied as the decision");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: buildCtoPrompt carries the lead exit-1 failover protocol", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-failover-"));
  try {
    const prompt = buildCtoPrompt(parseCtoEnvelope("execute ready handoff --spec oauth --run-key run-oauth", root), root);
    assert.ok(prompt.includes("Subagent dispatch reliability"), "reliability section present");
    assert.ok(prompt.includes("SAME slice spec"), "re-spawn with the same spec");
    assert.ok(prompt.includes("Second failure -> degrade"), "degradation path documented");
    assert.ok(prompt.includes("skip the lead hop"), "single-worker slices dispatch directly");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: buildCtoPrompt degrades without teams.json", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-"));
  try {
    const prompt = buildCtoPrompt(parseCtoEnvelope("execute ready handoff --spec oauth --run-key run-oauth", root), root);
    assert.ok(prompt.includes("(no teams configured)"));
    assert.ok(prompt.includes("Create `.omp/teams.json`"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: ctoCommand with empty args starts STANDBY and notifies on task", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-"));
  try {
    const notifyCalls: string[] = [];
    const standby = ctoCommand({ args: "", cwd: root, ui: { notify: (m) => notifyCalls.push(m) } });
    assert.ok(standby.includes("/cto STANDBY"), "empty args start standby mode");
    assert.ok(notifyCalls.some((m) => m.includes("awaiting tasks via messenger inbox")), "standby notification names the inbox contract");
    assert.ok(standby.includes("[CTO-INBOX]"), "standby documents the wake envelope");
    assert.ok(standby.includes("Use engine-owned standby state NOW"), "standby state is supplied by the engine/runtime");
    assert.ok(standby.includes("must not write `.work-state/cto`, state.json, waves, or inbox files directly"), "standby does not write canonical state directly");
    assert.ok(standby.includes("ARE USER COMMANDS"), "inbox messages are user commands to the main-session CTO");
    assert.ok(standby.includes("return to standby"), "standby returns to standby after each wave");
    assert.ok(standby.includes("task(agent=@cto)"), "nested CTO dispatch forbidden in standby");
    assert.ok(standby.includes("run id NEVER changes"), "standby keeps the SAME run id across follow-up waves");
    assert.ok(standby.includes("engine-owned wave"), "follow-up waves are engine-owned");
    assert.ok(standby.includes("four-tool confirmation sequence"), "ready specifications use the confirmation-gated sequence");
    assert.ok(!standby.includes("Adopt or persist the standby run"), "old direct standby persistence wording is gone");
    assert.ok(!standby.includes("append a `wave_history` record"), "old direct wave mutation wording is gone");
    assert.ok(!standby.includes("PER-SLICE"), "old direct classification/wave wording is gone");
    assert.ok(notifyCalls.some((m) => m.includes("standby")), "notify announces standby");

    const prompt = ctoCommand({ args: "Add OAuth", cwd: root, ui: { notify: (m) => notifyCalls.push(m) } });
    assert.ok(prompt.includes("Add OAuth"));
    assert.ok(notifyCalls.some((m) => m.includes("cto: Add OAuth")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: renderChannelSection reflects .omp/escalation.json", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-chan-"));
  try {
    // no channel
    assert.ok(renderChannelSection(root).includes("No escalation channel"));
    assert.ok(renderChannelSection(root).includes("Use the `ask` tool"));
    assert.ok(renderChannelSection(root).includes("TERMINAL-ONLY"), "none mode named TERMINAL-ONLY");

    // telegram -> bidirectional, ask banned
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "t", chatId: "c" } }));
    const tg = renderChannelSection(root);
    assert.ok(tg.includes("BIDIRECTIONAL"), "telegram is bidirectional");
    assert.ok(tg.includes("VALIDATED RW-PRIMARY"), "rw mode named VALIDATED RW-PRIMARY");
    assert.ok(tg.includes("NEVER use the `ask` tool"), "ask banned in messenger mode");
    assert.ok(tg.includes("outbox"), "questions route via the outbox");
    assert.ok(tg.includes("USER COMMAND"), "inbox tasks are user commands in messenger mode");

    // http -> push-only, ask allowed
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "http", http: { url: "https://x" } }));
    const http = renderChannelSection(root);
    assert.ok(http.includes("push-only"), "http is push-only");
    assert.ok(http.includes("RO-REPORT"), "ro mode named RO-REPORT");
    assert.ok(http.includes("Use `ask`"), "http keeps ask");

    // unregistered custom bidirectional transport is conservatively RO
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "slack", bidirectional: true }));
    const slack = renderChannelSection(root);
    assert.ok(slack.includes("RO-REPORT"), "unregistered custom transport stays RO");
    assert.ok(slack.includes("Use `ask`"), "unregistered custom transport keeps ask");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("cto-cmd: buildCtoPrompt embeds the channel section", () => {
  const root = mkdtempSync(join(tmpdir(), "cto-core-chan2-"));
  try {
    mkdirSync(join(root, ".omp"), { recursive: true });
    writeFileSync(join(root, ".omp", "escalation.json"), JSON.stringify({ adapter: "telegram", telegram: { token: "t", chatId: "c" } }));
    const prompt = buildCtoPrompt(parseCtoEnvelope("execute ready handoff --spec oauth --run-key run-oauth", root), root);
    assert.ok(prompt.includes("### User channel (messenger, BIDIRECTIONAL)"), "prompt carries the channel section");
    assert.ok(prompt.includes("NEVER use the `ask` tool"), "prompt bans ask in messenger mode");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
