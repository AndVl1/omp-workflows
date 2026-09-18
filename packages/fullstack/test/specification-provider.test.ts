import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  listConstitutionProviders,
  listDocumentRenderers,
  listFormatRecognizers,
  listSpecificationRenderers,
  NATIVE_CONSTITUTION_PROVIDER_ID,
  NATIVE_CONSTITUTION_TEMPLATE,
  resolveConstitutionProvider,
} from "@andvl1/omp-workflows-core";
import {
  registerNativeSpecificationAssets,
  fullstackOwnerForCwd,
  SPECKIT_CONSTITUTION_PROVIDER_ID,
  SPECKIT_CONSTITUTION_RELATIVE_PATH,
  speckitConstitutionProvider,
  specificationRecognizers,
} from "../src/index.js";

import { beginHeldRegistration, type HeldRegistration } from "./fixtures/guarded-registration.js";

function registerNativeSpecificationAssetsForTest(root: string): HeldRegistration {
  const registration = beginHeldRegistration(root, ["workflow_registration"], fullstackOwnerForCwd(root), ["constitution_providers", "format_recognizers"]);
  try {
    registerNativeSpecificationAssets(registration.token);
    registration.commit();
    return registration;
  } catch (error) {
    registration.close();
    throw error;
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

test("native assets register the SpecKit provider exactly once before native fallback", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-native-assets-provider-"));
  const registrations: HeldRegistration[] = [];
  try {
    registrations.push(registerNativeSpecificationAssetsForTest(root));
    registrations.push(registerNativeSpecificationAssetsForTest(root));
    const providers = listConstitutionProviders();
    assert.equal(providers.filter((id) => id === SPECKIT_CONSTITUTION_PROVIDER_ID).length, 1);
    assert.equal(providers.filter((id) => id === NATIVE_CONSTITUTION_PROVIDER_ID).length, 1);
    assert.ok(
      providers.indexOf(SPECKIT_CONSTITUTION_PROVIDER_ID) >= 0
        && providers.indexOf(SPECKIT_CONSTITUTION_PROVIDER_ID) < providers.indexOf(NATIVE_CONSTITUTION_PROVIDER_ID),
      "existing-file providers must precede the native fallback",
    );
  } finally {
    for (const registration of registrations) registration.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("native assets are idempotent and preserve built-in renderer/recognizer order", () => {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-native-assets-reset-"));
  const registrations: HeldRegistration[] = [];
  try {
    registrations.push(registerNativeSpecificationAssetsForTest(root));
    const initial = {
      document: listDocumentRenderers(),
      specification: listSpecificationRenderers(),
      recognizers: listFormatRecognizers(),
    };
    assert.deepEqual(initial.document, ["product-prd"]);
    assert.deepEqual(initial.specification, ["specification-markdown"]);
    assert.ok(initial.recognizers.length > 0);

    registrations.push(registerNativeSpecificationAssetsForTest(root));
    assert.deepEqual(listDocumentRenderers(), initial.document);
    assert.deepEqual(listSpecificationRenderers(), initial.specification);
    assert.deepEqual(listFormatRecognizers(), initial.recognizers);

    registrations.push(registerNativeSpecificationAssetsForTest(root));
    assert.deepEqual(listDocumentRenderers(), initial.document);
    assert.deepEqual(listSpecificationRenderers(), initial.specification);
    assert.deepEqual(listFormatRecognizers(), initial.recognizers);
  } finally {
    for (const registration of registrations) registration.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SpecKit root fixture resolves with provider provenance, native template hash, and no writes", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-provider-"));
  const registration = registerNativeSpecificationAssetsForTest(root);
  try {
    const relative = SPECKIT_CONSTITUTION_RELATIVE_PATH;
    const path = join(root, relative);
    mkdirSync(join(root, ".specify", "memory"), { recursive: true });
    writeFileSync(path, "# Existing policy\n\nNever rewrite this file.\n");
    const beforeBytes = readFileSync(path);
    const beforeTree = readdirSync(join(root, ".specify", "memory"));

    const discovered = speckitConstitutionProvider.discover(root);
    assert.deepEqual(discovered, [relative]);
    const resolved = resolveConstitutionProvider(root);
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    assert.equal(resolved.value.provider_id, SPECKIT_CONSTITUTION_PROVIDER_ID);
    assert.equal(resolved.value.source, "discovered_provider");
    assert.equal(resolved.value.path, relative);
    assert.equal(resolved.value.template_ref, NATIVE_CONSTITUTION_TEMPLATE.ref);
    assert.equal(resolved.value.template_hash, sha256(NATIVE_CONSTITUTION_TEMPLATE.content));
    assert.match(resolved.value.selection_hash, /^[0-9a-f]{64}$/);

    const repeated = resolveConstitutionProvider(root);
    assert.equal(repeated.ok, true);
    if (repeated.ok) assert.equal(repeated.value.selection_hash, resolved.value.selection_hash, "provenance hash must be deterministic");
    assert.deepEqual(readFileSync(path), beforeBytes, "discovery must be read-only");
    assert.deepEqual(readdirSync(join(root, ".specify", "memory")), beforeTree, "discovery must not create sibling assets");
  } finally {
    registration.close();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SpecKit discovery rejects symlinked roots and preserves native fallback when absent", () => {
  const root = mkdtempSync(join(tmpdir(), "spec-provider-safe-"));
  const outside = mkdtempSync(join(tmpdir(), "spec-provider-outside-"));
  try {
    const empty = resolveConstitutionProvider(root);
    assert.equal(empty.ok, true);
    if (empty.ok) {
      assert.equal(empty.value.provider_id, NATIVE_CONSTITUTION_PROVIDER_ID);
      assert.equal(empty.value.source, "native_default");
    }

    const external = join(outside, "constitution.md");
    writeFileSync(external, "# External policy\n");
    mkdirSync(join(root, ".specify", "memory"), { recursive: true });
    symlinkSync(external, join(root, SPECKIT_CONSTITUTION_RELATIVE_PATH));
    assert.equal(existsSync(join(root, SPECKIT_CONSTITUTION_RELATIVE_PATH)), true);
    assert.deepEqual(speckitConstitutionProvider.discover(root), [], "symlinked policy files must fail closed");
    const resolved = resolveConstitutionProvider(root);
    assert.equal(resolved.ok, true);
    if (resolved.ok) assert.equal(resolved.value.source, "native_default");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
