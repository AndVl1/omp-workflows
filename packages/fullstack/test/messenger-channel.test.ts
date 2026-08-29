import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createWorkflowV2Digest,
  type ActualAgentInventory,
  type AgentInventoryAuthority,
  type AgentInventoryAuthorityContext,
  type AgentRef,
  type ChannelProfile,
  type WorkflowV2Digest,
} from "@andvl1/omp-workflows-core";
import { MockEscalationAdapter } from "../src/adapters/mock.js";
import {
  channelMode,
  createAskRedirectGate,
  isBidirectionalChannel,
  validateMessengerContext,
  type MessengerChannelContext,
} from "../src/messenger-channel.js";
import { createTestFullstackInventoryAdmissionContext, type FullstackInventoryAdmissionContext } from "../src/agent-mapping.js";
import { runtimeFixture, type RuntimeFixture } from "./runtime-fixtures.js";

function digest(seed: string): WorkflowV2Digest {
  const value = createWorkflowV2Digest(`sha256:${createHash("sha256").update(seed, "utf8").digest("hex")}`);
  if (!value) throw new Error("test digest should be valid");
  return value;
}

function inventoryAdmission(
  fixture: RuntimeFixture,
): FullstackInventoryAdmissionContext {
  const agent: AgentRef = Object.freeze({
    registered_name: "analyst",
    provider_id: fixture.project_identity.provider_id,
    source_fingerprint: digest("analyst-source"),
  });
  const actual: ActualAgentInventory = Object.freeze({
    authority: "omp",
    provider_id: fixture.project_identity.provider_id,
    descriptor_fingerprint: fixture.project_identity.descriptor_fingerprint,
    agents: Object.freeze([agent]),
    inventory_fingerprint: digest(JSON.stringify([{
      provider_id: agent.provider_id,
      registered_name: agent.registered_name,
      source_fingerprint: agent.source_fingerprint,
    }])),
    reservation: Object.freeze({
      reservation_id: "messenger-reservation",
      fingerprint: digest("messenger-reservation"),
    }),
  });
  const authority: AgentInventoryAuthority = {
    resolve: () => ({ ok: true, value: actual, diagnostics: [] }),
  };
  const authorityContext = Object.freeze({
    canonical_root: fixture.project_root,
    session: fixture.project_identity.session,
    provider_id: fixture.project_identity.provider_id,
    descriptor_fingerprint: fixture.project_identity.descriptor_fingerprint,
    descriptor: Object.freeze({}),
    catalog: Object.freeze({}),
    effective_policy: Object.freeze({}),
  }) as unknown as AgentInventoryAuthorityContext;
  const context = createTestFullstackInventoryAdmissionContext({
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    canonical_root: fixture.project_root,
    agent_inventory: actual,
    agent_inventory_authority: authority,
    authority_context: authorityContext,
  });
  if (!context) throw new Error("test inventory admission should be issued");
  return context;
}

function messengerFixture(root: string, direction: ChannelProfile["direction"] = "rw", transport = "telegram"): MessengerChannelContext {
  const fixture = runtimeFixture(root, { runId: "messenger-run" });
  const adapter = new MockEscalationAdapter({
    project_root: fixture.project_root,
    run_identity: fixture.run_identity,
    filesystem_authority: fixture.filesystem_authority,
  });
  return {
    project_identity: fixture.project_identity,
    run_identity: fixture.run_identity,
    profile: { direction, transport, adapter: transport, run_identity: fixture.run_identity },
    adapter,
    filesystem_authority: fixture.filesystem_authority,
    inventory_admission: inventoryAdmission(fixture),
  };
}

test("messenger: channelMode uses the caller-supplied run-bound profile", () => {
  const root = mkdtempSync(join(tmpdir(), "chan-mode-"));
  try {
    assert.equal(channelMode(undefined), null, "missing context -> null");
    const telegram = messengerFixture(root, "rw", "telegram");
    assert.equal(channelMode(telegram), "telegram");
    const http = { ...messengerFixture(root, "ro", "http"), profile: { ...telegram.profile, direction: "ro" as const, transport: "http", adapter: "http" } };
    assert.equal(channelMode(http), "http");
    assert.equal(channelMode({ ...telegram, profile: { ...telegram.profile, run_identity: runtimeFixture(root, { runId: "other-run" }).run_identity } }), null, "foreign profile identity is rejected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("messenger: validated context requires trusted authority and host-issued inventory admission", () => {
  const root = mkdtempSync(join(tmpdir(), "messenger-validation-"));
  try {
    const context = messengerFixture(root);
    assert.equal(validateMessengerContext(undefined).ok, false);
    assert.equal(validateMessengerContext(context).ok, true);
    assert.equal(
      validateMessengerContext({
        ...context,
        inventory_admission: { ...context.inventory_admission },
      } as never).ok,
      false,
      "copied capability context is not a host-issued admission",
    );
    assert.equal(
      validateMessengerContext({
        ...context,
        inventory_admission: { agent_inventory: context.inventory_admission.agent_inventory },
      } as never).ok,
      false,
      "bare inventory projection is rejected",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("messenger: stale current inventory invalidates the channel", () => {
  const root = mkdtempSync(join(tmpdir(), "messenger-stale-"));
  try {
    const context = messengerFixture(root);
    const changed: ActualAgentInventory = Object.freeze({
      ...context.inventory_admission.agent_inventory,
      reservation: Object.freeze({
        reservation_id: "changed-reservation",
        fingerprint: digest("changed-reservation"),
      }),
    });
    const stale = createTestFullstackInventoryAdmissionContext({
      project_identity: context.project_identity,
      run_identity: context.run_identity,
      canonical_root: context.inventory_admission.canonical_root,
      agent_inventory: context.inventory_admission.agent_inventory,
      agent_inventory_authority: {
        resolve: () => ({ ok: true, value: changed, diagnostics: [] }),
      },
      authority_context: context.inventory_admission.authority_context,
    });
    assert.ok(stale);
    assert.equal(validateMessengerContext({ ...context, inventory_admission: stale! }).ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("messenger: ask gate blocks only for a validated bidirectional run-bound channel", () => {
  const root = mkdtempSync(join(tmpdir(), "ask-gate-"));
  try {
    const gate = createAskRedirectGate();
    assert.equal(gate({ toolName: "ask" }, {}), undefined, "missing messenger context -> pass");

    const context = messengerFixture(root, "rw", "telegram");
    const blocked = gate(
      { toolName: "ask" },
      { messenger: context, run_identity: context.run_identity },
    );
    assert.ok(blocked?.block === true, "validated rw channel blocks ask");
    assert.ok(blocked?.reason.includes("messenger-mode"));
    assert.ok(blocked?.reason.includes(context.run_identity.run_id), "reason names the exact run");

    const ro = messengerFixture(root, "ro", "http");
    assert.equal(
      gate({ toolName: "ask" }, { messenger: ro, run_identity: ro.run_identity }),
      undefined,
      "read-only channel does not block ask",
    );
    assert.equal(gate({ toolName: "read" }, { messenger: context, run_identity: context.run_identity }), undefined, "non-ask tools pass");
    assert.equal(isBidirectionalChannel(ro), false);
    assert.equal(
      gate(
        { toolName: "ask" },
        { messenger: context, run_identity: runtimeFixture(root, { runId: "foreign-run" }).run_identity },
      ),
      undefined,
      "foreign invocation run cannot redirect",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
