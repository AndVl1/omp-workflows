/**
 * Failing-first behavioral contracts for T080 (US6).
 *
 * These tests pin language provenance, marker-stable template precedence,
 * exact presentation bindings, and selective post-approval staleness.
 * They intentionally exercise public specification seams only; generation and
 * translation remain implementation concerns.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bindWorkspaceConstitution,
  captureWorkspaceRoot,
  createFeatureWorkspace,
  persistFeatureWorkspace,
  resolveFeatureWorkspace,
  updateSpecificationPresentation,
  type WorkspaceRootSnapshot,
} from "../src/specification/workspace.js";
import { materializeFeatureDocuments } from "../src/specification/materialize.js";
import { readPinnedCurrentConstitution } from "../src/specification/constitution-identities.js";
import { digestOf, extractSemanticMarkers, sha256Hex } from "../src/specification/validation.js";
import { setStateTransactionTestHooks } from "../src/engine/state.js";
import {
  loadShippedSpecificationTemplates,
  resolveSpecificationTemplate,
  resolveSpecificationTemplateSet,
} from "../src/specification/templates.js";
import { resolveSpecificationLanguage } from "../src/specification/language.js";
import { renderCanonicalPhaseDocument } from "../src/specification/phase.js";
import type { FeatureWorkspace, LanguageSelection, TemplateSelection } from "../src/specification/types.js";
import { specPreparationProfileHash, sha256, validConstitutionBinding, validFeatureWorkspace } from "./fixtures/specification-fixtures.js";

const constitutionDocument = "# Project Constitution v1.0.0\n\nVersion: 1.0.0\n\n## I. Quality\n\nShip tested work.\n";
const constitution = validConstitutionBinding({ content_sha256: sha256(constitutionDocument), semantic_hash: sha256(constitutionDocument.replace(/\s+/gu, " ").trim()) });
const REQUIRED_SPECIFY_MARKERS = ["problem", "scope", "non_goals", "actors", "journeys", "requirements", "edge_cases", "assumptions", "dependencies", "success_criteria"] as const;

function markerDocument(marker: string, heading: string, body: string): string {
  return `<!-- omp-spec:marker:${marker} -->\n## ${heading}\n\n${body}\n`;
}

function completeSpecifyTemplate(label: string): string {
  return REQUIRED_SPECIFY_MARKERS.map((marker) => markerDocument(marker, `${label} ${marker}`, `${label} ${marker} content.`)).join("\n");
}

function specifyModelForRendering() {
  return {
    schema_version: 1, feature_id: "rendering-feature", run_key: "rendering-run", phase: "specify", version: 1,
    worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: "dispatch-rendering" },
    constitution_binding: {}, upstream_versions: [],
    sections: { problem: "Problem body.", scope: "Scope body.", non_goals: "Non-goals body.", actors: "Actors body.", journeys: "Journeys body.", requirements: "Requirements body.", edge_cases: "Edge cases body.", assumptions: "Assumptions body.", dependencies: "Dependencies body.", success_criteria: "Success criteria body." },
    requirements: [], decisions: [], tasks: [], verification: [], contradictions: [], constitution_principles: [],
  } as never;
}

// ── FR-018/FR-020: language precedence and provenance ───────────────────────

test("language resolution uses feature override, then project default, then initiating request, with provenance", () => {
  const feature = resolveSpecificationLanguage({ featureOverride: "ru-RU", projectDefault: "de-DE", requestLanguage: "en-US" });
  assert.equal(feature.language, "ru-RU");
  assert.equal(feature.source, "feature_override");
  assert.equal(feature.selection_hash.length, 64);

  const project = resolveSpecificationLanguage({ projectDefault: "de-DE", requestLanguage: "en-US" });
  assert.equal(project.language, "de-DE");
  assert.equal(project.source, "project_default");

  const request = resolveSpecificationLanguage({ requestLanguage: "en-US" });
  assert.equal(request.language, "en-US");
  assert.equal(request.source, "request_language");
  assert.notEqual(feature.selection_hash, request.selection_hash);

  assert.throws(
    () => resolveSpecificationLanguage({}),
    /language.*(required|resolve|unavailable)/i,
    "no language source must fail closed rather than inventing a locale",
  );
});

test("localized prose keeps technical identifiers, command names, and authoritative quotations exact", () => {
  const selected = resolveSpecificationLanguage({ featureOverride: "ru-RU" });
  assert.equal(selected.language, "ru-RU");

  const localized = [
    markerDocument("problem", "Проблема", "REQ-001 Система создаёт читаемый документ. Команда `/specify` остаётся без перевода.\n\n> \"The API MUST remain executor-neutral.\""),
    markerDocument("scope", "Область", "Границы функции."),
    markerDocument("non_goals", "Не входит", "Не входит в работу."),
    markerDocument("actors", "Участники", "Участники процесса."),
    markerDocument("journeys", "Сценарии", "Сценарии использования."),
    markerDocument("requirements", "Требования", "REQ-001 должен быть проверяемым."),
    markerDocument("edge_cases", "Граничные случаи", "Ошибочные входные данные."),
    markerDocument("assumptions", "Предположения", "Среда выполнения доступна."),
    markerDocument("dependencies", "Зависимости", "Долговечное хранилище."),
    markerDocument("success_criteria", "Критерии успеха", "Критерий принятия."),
  ].join("\n");
  const resolved = resolveSpecificationTemplate({ template_id: "specify", feature_override_content: localized });
  assert.equal(resolved.ok, true);
  if (!resolved.ok) return;

  assert.equal(resolved.value.content, localized, "template resolution must not rewrite localized or technical text");
  assert.match(resolved.value.content, /Проблема/);
  assert.match(resolved.value.content, /REQ-001/);
  assert.match(resolved.value.content, /`\/specify`/);
  assert.match(resolved.value.content, /The API MUST remain executor-neutral/);
  assert.deepEqual(extractSemanticMarkers(resolved.value.content), [...REQUIRED_SPECIFY_MARKERS]);
});

// ── FR-005: template precedence and mandatory marker rejection ───────────────

test("template resolution chooses feature override before project default and shipped baseline", () => {
  const shipped = loadShippedSpecificationTemplates();
  assert.ok(shipped.specify, "the shipped specify baseline must be available");

  const project = completeSpecifyTemplate("Project");
  const feature = completeSpecifyTemplate("Feature");
  const featureResult = resolveSpecificationTemplate({ template_id: "specify", feature_override_content: feature, project_default_content: project });
  assert.equal(featureResult.ok, true);
  if (!featureResult.ok) return;
  assert.equal(featureResult.value.source, "feature_override");
  assert.equal(featureResult.value.content, feature);
  assert.equal(featureResult.value.content_hash, sha256Hex(feature));
  assert.deepEqual(featureResult.value.required_markers, [...REQUIRED_SPECIFY_MARKERS]);

  const projectResult = resolveSpecificationTemplate({ template_id: "specify", project_default_content: project });
  assert.equal(projectResult.ok, true);
  if (!projectResult.ok) return;
  assert.equal(projectResult.value.source, "project_default");
  assert.equal(projectResult.value.content, project);

  const shippedResult = resolveSpecificationTemplate({ template_id: "specify" });
  assert.equal(shippedResult.ok, true);
  if (!shippedResult.ok) return;
  assert.equal(shippedResult.value.source, "shipped_default");
  assert.equal(shippedResult.value.content, shipped.specify);
  assert.deepEqual(extractSemanticMarkers(shippedResult.value.content), [...REQUIRED_SPECIFY_MARKERS]);
});

test("canonical phase rendering applies the selected project template headings", () => {
  const templateContent = [
    "# Specification: {{FEATURE_NAME}}",
    "",
    "Feature: {{FEATURE_ID}}",
    "Run: {{RUN_KEY}}",
    "",
    "<!-- omp-spec:marker:problem -->",
    "## Ausgangslage",
    "{{PROBLEM}}",
    "",
    "<!-- omp-spec:marker:requirements -->",
    "## Anforderungen",
    "{{REQUIREMENTS}}",
    "",
    "<!-- omp-spec:marker:scope -->",
    "## Umfang",
    "{{SCOPE}}",
    "",
    "<!-- omp-spec:marker:non_goals -->",
    "## Nicht enthalten",
    "{{NON_GOALS}}",
    "",
    "<!-- omp-spec:marker:actors -->",
    "## Beteiligte",
    "{{ACTORS}}",
    "",
    "<!-- omp-spec:marker:journeys -->",
    "## Ablauf",
    "{{JOURNEYS}}",
    "",
    "<!-- omp-spec:marker:edge_cases -->",
    "## Grenzfälle",
    "{{EDGE_CASES}}",
    "",
    "<!-- omp-spec:marker:assumptions -->",
    "## Annahmen",
    "{{ASSUMPTIONS}}",
    "",
    "<!-- omp-spec:marker:dependencies -->",
    "## Abhängigkeiten",
    "{{DEPENDENCIES}}",
    "",
    "<!-- omp-spec:marker:success_criteria -->",
    "## Erfolgskriterien",
    "{{SUCCESS_CRITERIA}}",
    "",
  ].join("\n");
  const resolved = resolveSpecificationTemplate({ template_id: "specify", project_default_content: templateContent });
  assert.equal(resolved.ok, true, resolved.ok ? "" : resolved.error);
  if (!resolved.ok) return;
  const model = {
    schema_version: 1, feature_id: "custom-template", run_key: "run-custom-template", phase: "specify", version: 1,
    worker: { role: "specification-analyst", agent: "specification-worker", dispatch_id: "dispatch-custom-template" },
    constitution_binding: {}, upstream_versions: [],
    sections: { problem: "Das Problem.", scope: "Der Umfang.", non_goals: "Nicht enthalten.", actors: "Beteiligte.", journeys: "Ablauf.", requirements: "Anforderungen.", edge_cases: "Grenzfälle.", assumptions: "Annahmen.", dependencies: "Abhängigkeiten.", success_criteria: "Erfolgskriterien." },
    requirements: [], decisions: [], tasks: [], verification: [], contradictions: [], constitution_principles: [],
  } as never;
  const rendered = renderCanonicalPhaseDocument("specify", model, resolved.value);
  assert.match(rendered, /## Ausgangslage/u);
  assert.match(rendered, /## Anforderungen/u);
  assert.match(rendered, /## Umfang/u);
  assert.match(rendered, /## Erfolgskriterien/u);
  assert.doesNotMatch(rendered, /## Problem\n/u);
  assert.doesNotMatch(rendered, /## Requirements\n/u);
  assert.match(rendered, /Das Problem\./u);
});

test("shipped templates drive canonical bytes and retain every semantic section", () => {
  const selected = resolveSpecificationTemplate({ template_id: "specify" });
  assert.equal(selected.ok, true, selected.ok ? "" : selected.error);
  if (!selected.ok) return;
  const model = specifyModelForRendering();
  const rendered = renderCanonicalPhaseDocument("specify", model, selected.value);
  for (const section of REQUIRED_SPECIFY_MARKERS) {
    assert.match(rendered, new RegExp("omp-spec:marker:" + section));
    assert.match(rendered, new RegExp(section === "non_goals" ? "Non-goals body\\." : section.replace(/_/gu, " ") + " body\\.", "iu"));
  }
  assert.equal((rendered.match(/## Semantic Model/gu) ?? []).length, 1);
  const changedContent = selected.value.content.replace("## Problem", "## Problem (changed)");
  const changed = resolveSpecificationTemplate({ template_id: "specify", project_default_content: changedContent });
  assert.equal(changed.ok, true, changed.ok ? "" : changed.error);
  if (!changed.ok) return;
  const changedRendered = renderCanonicalPhaseDocument("specify", model, changed.value);
  assert.notEqual(changedRendered, rendered, "changing shipped-derived template content must change canonical bytes");
  assert.notEqual(sha256Hex(changedRendered), sha256Hex(rendered), "changing shipped-derived template content must change canonical hash");
});

test("template metadata normalization preserves identity-like section body lines", () => {
  const selected = resolveSpecificationTemplate({ template_id: "specify" });
  assert.equal(selected.ok, true, selected.ok ? "" : selected.error);
  if (!selected.ok) return;
  const bodyWithIdentity = selected.value.content.replace("{{PROBLEM}}", `# code\nFeature: foo\nRun: bar\n{{PROBLEM}}`);
  const custom = resolveSpecificationTemplate({ template_id: "specify", project_default_content: bodyWithIdentity });
  assert.equal(custom.ok, true, custom.ok ? "" : custom.error);
  if (!custom.ok) return;
  const rendered = renderCanonicalPhaseDocument("specify", specifyModelForRendering(), custom.value);
  assert.match(rendered, /\n# code\nFeature: foo\nRun: bar\nProblem body\./u);
  const firstMarker = rendered.indexOf("<!-- omp-spec:marker:problem -->");
  assert.ok(firstMarker > 0);
  const header = rendered.slice(0, firstMarker);
  for (const line of ["Feature: rendering-feature", "Run: rendering-run", "Version: 1", "Worker: specification-analyst (specification-worker)", "Dispatch: dispatch-rendering"]) {
    assert.equal(header.split("\n").filter((candidate) => candidate === line).length, 1, line + " must be emitted once in the canonical header");
  }
});

test("explicit legacy rendering stays byte-compatible while selected templates round-trip", () => {
  const model = specifyModelForRendering();
  const legacy = renderCanonicalPhaseDocument("specify", model);
  assert.match(legacy, /^# Specify\n/u);
  assert.match(legacy, /## Non Goals\n/u);
  assert.doesNotMatch(legacy, /omp-spec:marker:/u);
  const selected = resolveSpecificationTemplate({ template_id: "specify" });
  assert.equal(selected.ok, true, selected.ok ? "" : selected.error);
  if (!selected.ok) return;
  const templated = renderCanonicalPhaseDocument("specify", model, selected.value);
  assert.notEqual(templated, legacy);
  assert.equal((templated.match(/## Semantic Model/gu) ?? []).length, 1);
});

test("selected templates fail closed for missing markers and placeholders", () => {
  const selected = resolveSpecificationTemplate({ template_id: "specify" });
  assert.equal(selected.ok, true, selected.ok ? "" : selected.error);
  if (!selected.ok) return;
  const missingPlaceholder = { ...selected.value, content: selected.value.content.replace("{{PROBLEM}}", "") } as never;
  assert.throws(() => renderCanonicalPhaseDocument("specify", specifyModelForRendering(), missingPlaceholder), /mandatory placeholder/iu);
  const unresolved = { ...selected.value, content: selected.value.content.replace("{{PROBLEM}}", "{{UNRESOLVED}}") } as never;
  assert.throws(() => renderCanonicalPhaseDocument("specify", specifyModelForRendering(), unresolved), /unresolved placeholder/iu);
  const missingMarker = { ...selected.value, content: selected.value.content.replace("<!-- omp-spec:marker:problem -->\n", "") } as never;
  assert.throws(() => renderCanonicalPhaseDocument("specify", specifyModelForRendering(), missingMarker), /markers do not match/iu);
});

test("a template that removes stable mandatory markers is rejected before dispatch instead of silently falling through", () => {
  const validProject = completeSpecifyTemplate("Project");
  const markerlessFeature = "## Problem\n\nThis override has no omp marker.\n";
  const rejected = resolveSpecificationTemplate({ template_id: "specify", feature_override_content: markerlessFeature, project_default_content: validProject });
  assert.equal(rejected.ok, false);
  if (!rejected.ok) {
    assert.equal(rejected.code, "SPEC_TEMPLATE_MARKERS_MISSING");
    assert.match(rejected.error, /feature_override/);
  }

  const incompleteFeature = markerDocument("problem", "Problem", "only one required marker");
  const incomplete = resolveSpecificationTemplate({ template_id: "specify", feature_override_content: incompleteFeature, project_default_content: validProject });
  assert.equal(incomplete.ok, false);
  if (!incomplete.ok) {
    assert.equal(incomplete.code, "SPEC_TEMPLATE_MARKERS_MISSING");
    assert.match(incomplete.error, /requirements|scope|success_criteria/);
  }

  const setRejected = resolveSpecificationTemplateSet({
    template_ids: ["specify", "plan"],
    feature_overrides: { specify: validProject, plan: "# Plan without semantic markers" },
  });
  assert.equal(setRejected.ok, false);
  if (!setRejected.ok) {
    assert.equal(setRejected.code, "SPEC_TEMPLATE_MARKERS_MISSING");
    assert.match(setRejected.error, /plan.*feature_override/);
  }
});

// ── FR-019/FR-020: presentation binding and selective staleness ──────────────

function approvedPresentationWorkspace(root: string): FeatureWorkspace {
  const created = createFeatureWorkspace(root, {
    feature_id: "t080-language",
    display_name: "T080 language/template contract",
    run_key: "run-t080-language",
    profile_name: "spec-preparation",
    profile_hash: specPreparationProfileHash(),
  });
  assert.equal(created.ok, true);
  if (!created.ok) throw new Error(created.error);
  const expectedWorkspaceDigest = digestOf(created.value);
  writeFileSync(join(root, "CONSTITUTION.md"), constitutionDocument, "utf8");
  const gateId = "constitution-gate-t080";
  mkdirSync(join(root, ".work-state", "specification", "constitution"), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, ".work-state", "specification", "constitution", "gate.json"), JSON.stringify({ schema_version: 1, gate_id: gateId, project_root: root, feature_id: null, origin: { origin_kind: "native_direct", origin_run_key: "run-t080-language", origin_stage: "specify" }, gate: { gate_id: gateId, origin_kind: "native_direct", origin_run_key: "run-t080-language", origin_stage: "specify", status: "usable", usability_result: "usable", provider: { provider_id: "native", path: "CONSTITUTION.md", source: "native_default" }, constitution_workflow_ref: null, checkpoint_ref: null, binding: constitution, resume_marker: null }, drafts: [], decisions: [] }, null, 2) + "\n", "utf8");
  const bound = bindWorkspaceConstitution(created.value, constitution);
  const specify = bound.phases.find((phase) => phase.phase === "specify")!;
  specify.status = "approved";
  specify.current_version = 1;
  specify.approved_version = 1;
  specify.validation_ref = "validation.specify.v1";
  specify.checkpoint_ref = "checkpoint.specify.v1";
  const plan = bound.phases.find((phase) => phase.phase === "plan")!;
  plan.status = "awaiting_approval";
  plan.current_version = 1;
  plan.validation_ref = "validation.plan.v1";
  plan.upstream_versions = [{ phase: "specify", version: 1, hash: sha256("specify.v1") }];
  bound.status = "in_progress";
  const persisted = persistFeatureWorkspace(root, bound, undefined, { expected_workspace_digest: expectedWorkspaceDigest });
  assert.equal(persisted.ok, true, persisted.ok ? "" : persisted.error);
  if (!persisted.ok) throw new Error(persisted.error);

  for (const [phase, path, marker] of [["specify", "spec.md", "problem"], ["plan", "plan.md", "decisions"]] as const) {
    const materialized = materializeFeatureDocuments(root, {
      feature_id: bound.feature_id,
      run_key: "run-t080-language",
      phase,
      version: 1,
      documents: [{ path, content: markerDocument(marker, phase, `Materialized ${phase} content.`) }],
    }, { validateBeforeWrite: () => {
      const snapshot = captureWorkspaceRoot(root);
      if (!snapshot) throw new Error("SPEC_PATH_UNAUTHORIZED: presentation fixture root cannot be pinned");
      try {
        const current = resolveFeatureWorkspace(root, { feature_id: bound.feature_id, run_key: "run-t080-language" }, snapshot);
        if (!current.ok || !current.value.constitution_binding) throw new Error("SPEC_STALE: presentation workspace constitution binding is unavailable");
        const live = readPinnedCurrentConstitution(snapshot.canonical_root, snapshot.pinned_root, current.value.constitution_binding);
        if (!live.ok) throw new Error("SPEC_STALE: " + live.error);
      } finally {
        snapshot.pinned_root.close();
      }
    } });
    assert.equal(materialized.ok, true);
  }
  return bound;
}

test("presentation changes bind exact language/template selections and stale only materialized approvals", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-t080-presentation-"));
  try {
    const workspace = approvedPresentationWorkspace(root);
    const language: LanguageSelection = { language: "ru-RU", source: "feature_override", selection_hash: sha256("language:ru-RU") };
    const template: TemplateSelection = { template_set_id: "specification-default", source: "project_default", content_hash: sha256("template-set:project-ru"), required_markers: [...REQUIRED_SPECIFY_MARKERS] };
    const changed = updateSpecificationPresentation(root, { feature_id: workspace.feature_id, run_key: "run-t080-language", language, template });
    assert.equal(changed.changed, true);
    assert.deepEqual(changed.affected_phases, ["specify", "plan"]);
    assert.deepEqual(changed.staled_approvals, ["specify.v1", "plan.v1"]);
    assert.equal(changed.next_action.kind, "remediation");
    assert.match(changed.next_action.reason, /(language|template).*(changed|regenerat)/i);

    const resolved = resolveFeatureWorkspace(root, { feature_id: workspace.feature_id, run_key: "run-t080-language" });
    assert.equal(resolved.ok, true);
    if (resolved.ok) {
      assert.equal(resolved.value.language.selection_hash, language.selection_hash);
      assert.equal(resolved.value.template_set.content_hash, template.content_hash);
      assert.equal(resolved.value.phases.find((phase) => phase.phase === "specify")?.status, "stale");
      assert.equal(resolved.value.phases.find((phase) => phase.phase === "plan")?.status, "stale");
      assert.equal(resolved.value.phases.find((phase) => phase.phase === "tasks")?.status, "not_started");
    }

    const replay = updateSpecificationPresentation(root, { feature_id: workspace.feature_id, run_key: "run-t080-language", language, template });
    assert.equal(replay.changed, false, "rebinding identical selections is idempotent");
    assert.deepEqual(replay.affected_phases, []);
    assert.deepEqual(replay.staled_approvals, []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("changing only one presentation binding does not mutate the other binding", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-t080-binding-"));
  try {
    const workspace = approvedPresentationWorkspace(root);
    const language: LanguageSelection = { language: "ru-RU", source: "feature_override", selection_hash: sha256("language:ru-RU") };
    const languageChange = updateSpecificationPresentation(root, { feature_id: workspace.feature_id, run_key: "run-t080-language", language });
    assert.equal(languageChange.changed, true);
    const afterLanguage = resolveFeatureWorkspace(root, { feature_id: workspace.feature_id, run_key: "run-t080-language" });
    assert.equal(afterLanguage.ok, true);
    if (!afterLanguage.ok) return;
    assert.equal(afterLanguage.value.language.selection_hash, language.selection_hash);
    assert.equal(afterLanguage.value.template_set.content_hash, workspace.template_set.content_hash);

    const template: TemplateSelection = { template_set_id: "project-ru", source: "project_default", content_hash: sha256("template-set:project-ru"), required_markers: ["problem", "requirements"] };
    const templateChange = updateSpecificationPresentation(root, { feature_id: workspace.feature_id, run_key: "run-t080-language", template });
    assert.equal(templateChange.changed, true);
    const afterTemplate = resolveFeatureWorkspace(root, { feature_id: workspace.feature_id, run_key: "run-t080-language" });
    assert.equal(afterTemplate.ok, true);
    if (afterTemplate.ok) {
      assert.equal(afterTemplate.value.template_set.content_hash, template.content_hash);
      assert.equal(afterTemplate.value.language.selection_hash, language.selection_hash);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("presentation update rejects constitution drift at the state CAS boundary", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-t080-constitution-race-"));
  let injected = false;
  try {
    const workspace = approvedPresentationWorkspace(root);
    const statePath = join(root, ".work-state", "features", workspace.feature_id, "state.json");
    const before = readFileSync(statePath);
    setStateTransactionTestHooks({ beforeCas: () => {
      if (injected) return;
      injected = true;
      writeFileSync(join(root, "CONSTITUTION.md"), "# Drifted constitution\n", "utf8");
    } }, root);
    assert.throws(
      () => updateSpecificationPresentation(root, {
        feature_id: workspace.feature_id,
        run_key: "run-t080-language",
        language: { language: "ru-RU", source: "feature_override", selection_hash: sha256("language:ru-RU") },
      }),
      /SPEC_STALE|pre-commit guard/u,
    );
    assert.equal(injected, true, "the deterministic CAS hook must run");
    assert.deepEqual(readFileSync(statePath), before, "constitution drift must not persist a presentation mutation");
  } finally {
    setStateTransactionTestHooks(null, root);
    rmSync(root, { recursive: true, force: true });
  }
});

test("presentation update rejects a project-root swap after descriptor capture without rebinding state", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-t080-presentation-race-"));
  const moved = `${root}.opened`;
  let pinned: WorkspaceRootSnapshot | null = null;
  let swapped = false;
  try {
    const workspace = approvedPresentationWorkspace(root);
    const statePath = join(root, ".work-state", "features", workspace.feature_id, "state.json");
    const before = readFileSync(statePath, "utf8");
    pinned = captureWorkspaceRoot(root);
    assert.ok(pinned, "presentation update must capture a pinned root");
    renameSync(root, moved);
    swapped = true;
    mkdirSync(root);

    assert.throws(
      () => updateSpecificationPresentation(root, {
        feature_id: workspace.feature_id,
        run_key: "run-t080-language",
        language: { language: "ru-RU", source: "feature_override", selection_hash: sha256("language:ru-RU") },
      }, pinned),
      /SPEC_PATH_UNAUTHORIZED|project root changed/u,
    );
    assert.equal(readFileSync(join(moved, ".work-state", "features", workspace.feature_id, "state.json"), "utf8"), before, "root swap must not rebind or mutate the original state");
  } finally {
    pinned?.pinned_root.close();
    if (swapped) {
      rmSync(root, { recursive: true, force: true });
      renameSync(moved, root);
    }
    rmSync(root, { recursive: true, force: true });
    rmSync(moved, { recursive: true, force: true });
  }
});
