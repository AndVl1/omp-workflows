/**
 * Package contract tests for the published fullstack surface.
 *
 * The extension root intentionally remains the runtime entrypoint. Consumer
 * transports use the narrow `./adapters` subpath and an opaque core registry
 * token; dispatcher, queue, bridge, and raw registry helpers are not public.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { listFormatRecognizers } from "@andvl1/omp-workflows-core";
import {
  closeWorkflowActivation,
  beginRegistryRegistration,
  openWorkflowActivation,
  rollbackRegistryRegistration,
  type RegistryRegistrationToken,
} from "@andvl1/omp-workflows-core/registry";
import * as publicAdapters from "@andvl1/omp-workflows-fullstack/adapters";
import {
  registerSpecificationRecognizers,
  specificationRecognizerById,
  specificationRecognizers,
} from "../src/index.js";
import { writeFullstackActivationMarker } from "../src/activation-marker.js";
import { fullstackTestOwner } from "./mock-registration.js";

const here = dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")) as {
  version: string;
  peerDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
};

const ownMinor = manifest.version.split(".").slice(0, 2).join(".");
const expectedCorePeer = `^${ownMinor}.0`;

function beginFormatRegistration(): { root: string; token: RegistryRegistrationToken; release: () => void } {
  const root = mkdtempSync(join(tmpdir(), "omp-fullstack-recognizer-contract-"));
  writeFullstackActivationMarker(root);
  const activation = openWorkflowActivation(root, ["workflow_registration"], fullstackTestOwner(root));
  if (!activation.ok) {
    rmSync(root, { recursive: true, force: true });
    throw new Error(`${activation.code}: ${activation.error}`);
  }
  const transaction = beginRegistryRegistration(activation.registry_context, root, ["format_recognizers"]);
  if (!transaction.ok) {
    closeWorkflowActivation(activation);
    rmSync(root, { recursive: true, force: true });
    throw new Error(`${transaction.code}: ${transaction.error}`);
  }
  return {
    root,
    token: transaction.token,
    release: () => {
      try { rollbackRegistryRegistration(transaction.token); } finally {
        closeWorkflowActivation(activation);
        rmSync(root, { recursive: true, force: true });
      }
    },
  };
}

test("fullstack: core peer range matches fullstack's own minor line and is not a wildcard", () => {
  const corePeer = manifest.peerDependencies?.["@andvl1/omp-workflows-core"];
  assert.ok(corePeer, "fullstack must declare @andvl1/omp-workflows-core as a peer dependency");
  assert.notEqual(
    corePeer,
    "*",
    "wildcard core peer lets npm resolve an incompatible core (e.g. 0.12.x) — pin to the same minor line",
  );
  assert.equal(
    corePeer,
    expectedCorePeer,
    `core peer must be ${expectedCorePeer} (same minor line as fullstack ${manifest.version})`,
  );
});

test("fullstack: ordinary dependency install has no activation side effect", () => {
  assert.equal(manifest.scripts?.postinstall, undefined, "postinstall must not copy commands or activate projects");
  assert.equal(typeof manifest.scripts?.["copy-commands"], "string", "copy remains an explicit command");
});

test("fullstack: core exposes the curated activation closer used by docs", () => {
  assert.equal(typeof closeWorkflowActivation, "function");
});

test("fullstack: adapters subpath exposes only the token-bound consumer surface", () => {
  assert.deepEqual(
    Object.keys(publicAdapters).sort(),
    ["createEscalationAdapter", "registerEscalationAdapter"],
    "dispatcher, queue, bridge, and raw registry helpers must stay private",
  );
  assert.equal(typeof publicAdapters.registerEscalationAdapter, "function");
  assert.equal(typeof publicAdapters.createEscalationAdapter, "function");
  for (const rawName of [
    "createChannelSet",
    "drainOutbox",
    "startDispatcher",
    "startChannelDispatcher",
    "queueCtoDelivery",
    "handleInboxTask",
    "loadEscalationConfig",
    "dispatcherLockPath",
    "writeBridgeLock",
  ]) {
    assert.equal(rawName in publicAdapters, false, `${rawName} must not be a public adapter export`);
  }
});

test("fullstack: pi-coding-agent peer stays a wildcard (extension API is unversioned)", () => {
  assert.equal(manifest.peerDependencies?.["@oh-my-pi/pi-coding-agent"], "*");
});
test("fullstack native specification roles use the dedicated worker asset", () => {
  const assetsDir = resolve(here, "..", "agents");
  const worker = readFileSync(resolve(assetsDir, "specification-worker.md"), "utf8");
  assert.match(worker, /^name: specification-worker$/mu);
  assert.match(worker, /^model: \["@task"\]$/mu);
  assert.match(worker, /^thinkingLevel: auto$/mu);
  assert.match(worker, /^tools: read$/mu);
  assert.match(worker, /exact standalone `NATIVE_WORKER_INPUT` marker/iu);
  assert.match(worker, /bounded single-pass transformation/iu);
  assert.doesNotMatch(worker, /low.?effort|exact effort/iu);
  assert.match(worker, /do not perform extended analysis or research/iu);
  assert.match(worker, /fill the strict worker_result schema directly from the embedded inputs/iu);
  assert.doesNotMatch(worker, /semantic_model/iu);
  assert.match(worker, /do not emit, copy, or invent those(?: or any other)? engine-owned(?: envelope)? fields/iu);
  assert.match(worker, /exactly seven authored keys: sections, requirements, decisions, tasks, verification, contradictions, and constitution_principles/iu);
  assert.match(worker, /yield exactly once/iu);
  for (const agent of ["analyst", "architect"] as const) {
    const raw = readFileSync(resolve(assetsDir, `${agent}.md`), "utf8");
    assert.doesNotMatch(raw, /Native Specification Worker Mode/iu, `${agent}: legacy native block must be removed`);
  }
});
test("fullstack: package root ships named recognizers and registers every provider", () => {
  const expectedIds: Record<string, true> = {
    speckit: true,
    openspec: true,
    bmad: true,
    superpowers: true,
    xpowers: true,
    generic: true,
  };
  const recognizers = specificationRecognizers();
  assert.equal(recognizers.length, Object.keys(expectedIds).length);
  assert.deepEqual(
    Object.fromEntries(recognizers.map((recognizer) => [recognizer.recognizer_id, true])),
    expectedIds,
  );
  for (const id of Object.keys(expectedIds)) {
    const recognizer = specificationRecognizerById(id);
    assert.ok(recognizer, `${id} recognizer/provider is publicly resolvable`);
    assert.equal(typeof recognizer.recognize, "function", `${id} recognizer exposes executable recognition`);
  }

  const registration = beginFormatRegistration();
  try {
    registerSpecificationRecognizers(registration.token);
    assert.deepEqual(
      Object.fromEntries(listFormatRecognizers().map((id) => [id, true])),
      expectedIds,
    );
    registerSpecificationRecognizers(registration.token);
    assert.deepEqual(
      Object.fromEntries(listFormatRecognizers().map((id) => [id, true])),
      expectedIds,
      "registration is idempotent",
    );
  } finally {
    registration.release();
  }
});
