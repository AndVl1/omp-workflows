/**
 * Host-ingress hardening for `workflow_checkpoint_ask` (br-zps review fixes):
 *
 *   - AbortSignal: canceled calls reject before the UI, after the dialog
 *     resolves, and immediately before the synchronous engine commit — a
 *     canceled call never mints an answer, and the host dialog options
 *     receive the signal.
 *   - Durable commit seam: the entire post-dialog flow is ONE
 *     `commitCheckpointAnswer` transaction — fresh-state revalidation,
 *     already-finalized replay, conflicting-decision rejection, live-proof
 *     reuse/supersession, and the CAS commit are engine-owned; a cursor,
 *     capability, or decision transition while the dialog is open rejects
 *     without persisting or rolling back the concurrent writer.
 *   - Strict state↔capability coherence: malformed capabilities, state↔cap
 *     drift, stale branches, profile drift, and state↔profile policy drift
 *     fail closed before any human prompt.
 *   - Duplicate-proof guard: exact replay of a live identical answer stays
 *     idempotent; conflicting or concurrent asks supersede stale live
 *     proofs across BOTH channels so at most one unconsumed answer exists
 *     per unresolved checkpoint, and a superseded proof can never authorize
 *     the follow-up `workflow_checkpoint` call.
 *   - Strict installed-host result parsing: only exactly one selected
 *     policy-allowed decision for the exact question — echoing its text and
 *     options, strict single-select (`multi === false`), one string
 *     selection, valid optional `timedOut`/`customInput` fields, and no
 *     metadata outside the installed host's `ExtensionAskDialogResultItem`
 *     contract — authorizes; anything else records nothing.
 *   - Loop-iteration binding: the handoff's `loop_iteration` is enforced
 *     when present, echoed verbatim in the answer payload, and propagates
 *     into the ledger decision scope.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z as zod } from "zod";
import { loadProfile, profileHash } from "../src/engine/profile.js";
import { createCapability, recordCheckpointDecision, type IssuedCapability } from "../src/engine/durable.js";
import { recordTrustedCheckpointAnswer } from "../src/engine/checkpoints.js";
import { resolveState, writeStateBootstrap } from "../src/engine/state.js";
import { registerWorkflowTools } from "../src/index.js";
import type { TeamState } from "../src/engine/types.js";

type AskParams = Record<string, unknown>;
type AskResponse = { details: AskParams };
type DialogQuestion = { id: string; question: string; header?: string; options: Array<{ label: string }>; multi?: boolean };
type DialogOptions = { signal?: AbortSignal };
type AskContext = Record<string, unknown>;
type AskExecute = (id: string, params: AskParams, signal: AbortSignal | undefined, update: undefined, ctx: AskContext) => Promise<AskResponse>;
type DialogScript = (questions: DialogQuestion[], dialogOptions: DialogOptions | undefined) => unknown;
interface DialogCall {
  questions: DialogQuestion[];
  options: DialogOptions | undefined;
}

/** Register the workflow tools with a fake host and return them by name. */
function registerTools(): Map<string, { name: string; execute: never }> {
  const registered = new Map<string, { name: string; execute: never }>();
  registerWorkflowTools({
    zod: { z: zod },
    registerTool: (tool: { name: string; execute: never }) => {
      registered.set(tool.name, tool);
    },
  } as never, {
    isMainSession: () => true,
    resolveCwd: (ctx: unknown) => (ctx as { cwd?: string }).cwd,
  });
  return registered;
}

function askExecute(tools: Map<string, { name: string; execute: never }>): AskExecute {
  const ask = tools.get("workflow_checkpoint_ask");
  assert.ok(ask, "workflow_checkpoint_ask must be registered");
  return ask.execute as unknown as AskExecute;
}

function writeAskFixture(root: string): IssuedCapability {
  const profile = loadProfile("lightweight");
  assert.ok(profile, "lightweight profile must be available");
  const persistedProfileHash = profileHash(profile);
  const issued = createCapability({
    run_key: "main",
    branch: "main",
    workflow: "lightweight",
    profile_hash: persistedProfileHash,
    stage_cursor: "implementation",
    kind: "single",
    expected_roster: [{ role: "developer-kotlin", agent: "developer-kotlin" }],
  });
  writeStateBootstrap(root, {
    schema: 1,
    branch: "main",
    run_key: "main",
    classification: { type: "FEATURE", complexity: "QUICK", confidence: "HIGH", autonomous: false, workflow: "lightweight" },
    task: "checkpoint ask hardening",
    stage_cursor: "implementation",
    stages: profile.stages.map((stage) => ({ id: stage.id, status: stage.id === "implementation" ? "in_progress" as const : "pending" as const })),
    artifacts: {},
    scope: { scope: [], has_security: false, has_infra: false, has_ui: false, has_runtime: false, dev_agent: "developer-kotlin" },
    policy: { strict_orchestrator: true },
    pause: { kind: "none", reason: "" },
    profile_hash: persistedProfileHash,
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    dispatch_capability: issued.state,
    updated_at: new Date().toISOString(),
  }, { featureSlug: "ask-hardening" });
  return issued;
}

function askAuth(issued: IssuedCapability): AskParams {
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: "main",
    branch: "main",
    workflow: "lightweight",
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    checkpoint: "approve_implementation",
    checkpoint_id: "approve_implementation",
    checkpoint_kind: "implementation_approval",
  };
}

function askContext(root: string, script: DialogScript, calls: DialogCall[]): AskContext {
  return {
    cwd: root,
    hasUI: true,
    ui: {
      async askDialog(questions: DialogQuestion[], dialogOptions: DialogOptions): Promise<unknown> {
        calls.push({ questions, options: dialogOptions });
        return await script(questions, dialogOptions);
      },
    },
  };
}

type SubmitExtra = Partial<{ id: string; question: string; options: string[]; multi: boolean; timedOut: boolean; customInput: string; note: string }>;

/** The canonical result item a faithful host echoes for the asked question. */
function canonicalItem(question: DialogQuestion): Record<string, unknown> {
  return {
    id: question.id,
    question: question.question,
    options: question.options.map((option) => option.label),
    multi: false,
    selectedOptions: [] as string[],
  };
}

function submit(question: DialogQuestion, selection: string[], extra: SubmitExtra = {}): unknown {
  return {
    kind: "submit",
    results: [{
      ...canonicalItem(question),
      selectedOptions: selection,
      ...(extra.id !== undefined ? { id: extra.id } : {}),
      ...(extra.question !== undefined ? { question: extra.question } : {}),
      ...(extra.options !== undefined ? { options: extra.options } : {}),
      ...(extra.multi !== undefined ? { multi: extra.multi } : {}),
      ...(extra.timedOut !== undefined ? { timedOut: extra.timedOut } : {}),
      ...(extra.customInput !== undefined ? { customInput: extra.customInput } : {}),
      ...(extra.note !== undefined ? { note: extra.note } : {}),
    }],
  };
}

function withoutEcho(question: DialogQuestion, key: string): unknown {
  const item = canonicalItem(question);
  delete item[key];
  return { kind: "submit", results: [item] };
}

function readStateFile(root: string): TeamState {
  const resolved = resolveState(root);
  assert.ok(resolved.state, "fixture state must resolve");
  return resolved.state;
}

function persistedAnswers(root: string): Array<Record<string, unknown>> {
  return (readStateFile(root).trusted_checkpoint_answers ?? []) as unknown as Array<Record<string, unknown>>;
}

/** Answer records read from the raw state file: a tampered state that normalization rejects can never resolve. */
function persistedRawAnswers(root: string): Array<Record<string, unknown>> {
  const resolved = resolveState(root);
  const raw = JSON.parse(readFileSync(resolved.statePath!, "utf8")) as { trusted_checkpoint_answers?: Array<Record<string, unknown>> };
  return raw.trusted_checkpoint_answers ?? [];
}

function overwriteStateFile(root: string, mutate: (raw: Record<string, unknown>) => void): void {
  const resolved = resolveState(root);
  assert.ok(resolved.statePath);
  const raw = JSON.parse(readFileSync(resolved.statePath, "utf8")) as Record<string, unknown>;
  mutate(raw);
  writeFileSync(resolved.statePath, JSON.stringify(raw, null, 2) + "\n");
}

/**
 * Seed MULTIPLE genuinely live answers for one question by deriving each
 * from the SAME pre-answer state: `recordTrustedCheckpointAnswer` supersedes
 * live siblings on every mint, so chained calls can never construct the
 * pre-existing duplicate scenario — the raw fixture bypasses the chaining.
 */
function seedLiveAnswers(root: string, entries: Array<{ answerId: string; decision: string }>): void {
  const resolved = resolveState(root);
  assert.ok(resolved.state);
  const minted = entries.map(({ answerId, decision }) =>
    recordTrustedCheckpointAnswer(resolved.state, {
      answer_id: answerId,
      channel: "terminal",
      reference: `terminal-answer/seeded/${answerId}`,
      stage_id: "implementation",
      checkpoint_id: "approve_implementation",
      decision,
    }));
  const answers = minted.flatMap((result) => result.state.trusted_checkpoint_answers ?? []);
  writeStateBootstrap(root, { ...resolved.state, trusted_checkpoint_answers: answers }, { target: resolved });
}

function seedLiveAnswer(root: string, answerId: string, decision: string): void {
  const resolved = resolveState(root);
  assert.ok(resolved.state);
  const trusted = recordTrustedCheckpointAnswer(resolved.state, {
    answer_id: answerId,
    channel: "terminal",
    reference: `terminal-answer/seeded/${answerId}`,
    stage_id: "implementation",
    checkpoint_id: "approve_implementation",
    decision,
  });
  writeStateBootstrap(root, trusted.state, { target: resolved });
}

/** Record `decision` with a durable escalation proof, as another trusted surface would. */
function recordEscalationDecision(root: string, issued: IssuedCapability, decision: string): void {
  const resolved = resolveState(root);
  assert.ok(resolved.state);
  const trusted = recordTrustedCheckpointAnswer(resolved.state, {
    answer_id: `durable/implementation/approve_implementation/${decision}`,
    channel: "escalation",
    reference: `escalation-answer/durable/implementation/approve_implementation/${decision}`,
    stage_id: "implementation",
    checkpoint_id: "approve_implementation",
    decision,
  });
  writeStateBootstrap(root, trusted.state, { target: resolved });
  const recorded = recordCheckpointDecision(root, {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: "main",
    branch: "main",
    workflow: "lightweight",
    profile_hash: profileHash(loadProfile("lightweight")!),
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    checkpoint: "approve_implementation",
    checkpoint_id: "approve_implementation",
    checkpoint_kind: "implementation_approval",
    authorization: "human",
    actor_provenance: { kind: "user", ref: trusted.answer.reference, proof: trusted.proof },
    decision,
    rationale: `recorded concurrently while the dialog was open (${decision})`,
  });
  assert.equal(recorded.ok, true, "the concurrent recording must succeed inside the scenario");
}

/** The exact workflow_checkpoint envelope for the fixture handoff binding. */
function checkpointEnvelope(issued: IssuedCapability): Record<string, unknown> {
  return {
    token: issued.advance_token,
    capability_id: issued.capability_id,
    run_key: "main",
    branch: "main",
    workflow: "lightweight",
    profile_hash: profileHash(loadProfile("lightweight")!),
    stage_cursor: "implementation",
    cursor_epoch: issued.state.issued_for!.cursor_epoch,
    loop_iteration: 1,
    checkpoint: "approve_implementation",
    checkpoint_id: "approve_implementation",
    checkpoint_kind: "implementation_approval",
    authorization: "human",
  };
}

function withFixture(name: string, run: (root: string, ask: AskExecute, tools: Map<string, { name: string; execute: never }>) => Promise<void>): void {
  return test(name, async () => {
    const root = mkdtempSync(join(tmpdir(), "omp-ask-hardening-"));
    try {
      execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
      const tools = registerTools();
      await run(root, askExecute(tools), tools);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

withFixture("ask: a canceled call rejects before any human prompt and mints nothing", async (root, ask) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];
  const controller = new AbortController();
  controller.abort();
  // The abort gate fires before any validation, so the dialog script here is
  // only a tripwire: it must never run.
  const response = await ask("t", { ...askAuth(issued) }, controller.signal, undefined, askContext(root, () => {
    throw new Error("dialog must not be presented for a canceled call");
  }, calls));
  const details = response.details as { ok?: boolean; code?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_ABORTED");
  assert.deepEqual(calls, [], "the dialog is never presented for a canceled call");
  assert.equal(persistedAnswers(root).length, 0, "a canceled call never mints an answer");
});

withFixture("ask: cancellation during the dialog propagates the signal, rejects after the await, and records nothing", async (root, ask) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];
  const controller = new AbortController();
  const response = await ask("t", askAuth(issued), controller.signal, undefined, askContext(root, (questions, dialogOptions) => {
    assert.ok(dialogOptions?.signal instanceof AbortSignal, "the host dialog options must receive the abort signal");
    assert.equal(dialogOptions.signal, controller.signal, "the tool's own signal is propagated to the dialog");
    assert.equal(questions.length, 1);
    assert.deepEqual(questions[0]!.options.map((option) => option.label), ["proceed", "reject"], "only policy-allowed decisions are displayed");
    return (async () => {
      await Promise.resolve();
      controller.abort();
      return submit(questions[0]!, ["proceed"]);
    })();
  }, calls));
  const details = response.details as { ok?: boolean; code?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_ABORTED");
  assert.equal(persistedAnswers(root).length, 0, "an answer produced after cancellation is never minted");
});

withFixture("ask: a cursor/capability transition while the dialog is open rejects without persisting or rolling back", async (root, ask) => {
  const issued = writeAskFixture(root);
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => {
    // Simulate a concurrent engine transition: rotate the cursor epoch and
    // re-bind the capability while the human dialog is open.
    const resolved = resolveState(root);
    assert.ok(resolved.state);
    const cap = resolved.state.dispatch_capability!;
    const rotated: TeamState = {
      ...resolved.state,
      cursor_epoch: "rotated-epoch",
      dispatch_capability: { ...cap, issued_for: { ...cap.issued_for!, cursor_epoch: "rotated-epoch" } },
    };
    writeStateBootstrap(root, rotated, { target: resolved });
    return submit(questions[0]!, ["proceed"]);
  }, []));
  const details = response.details as { ok?: boolean; code?: string; error?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_REJECTED");
  assert.match(details.error ?? "", /workflow state changed while the dialog was open/);
  assert.match(details.error ?? "", /capability binding mismatch/);
  // The concurrent writer survives untouched; no stale snapshot was written over it.
  const after = readStateFile(root);
  assert.equal(after.cursor_epoch, "rotated-epoch");
  assert.equal(after.dispatch_capability!.issued_for!.cursor_epoch, "rotated-epoch");
  assert.equal(persistedAnswers(root).length, 0, "the stale human answer is never persisted");
});

withFixture("ask: a conflicting decision recorded while the dialog was open rejects without touching the ledger", async (root, ask) => {
  const issued = writeAskFixture(root);
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => {
    recordEscalationDecision(root, issued, "reject");
    return submit(questions[0]!, ["proceed"]);
  }, []));
  const details = response.details as { ok?: boolean; code?: string; error?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_REJECTED");
  assert.match(details.error ?? "", /conflicting decision 'reject' was already recorded/);
  const after = readStateFile(root);
  assert.equal((after.typed_checkpoint_decisions ?? []).length, 1, "the recorded decision is untouched");
  assert.equal(persistedAnswers(root).length, 1, "no additional answer was minted");
});

withFixture("ask: an identical selection after a decision was recorded mid-dialog replays idempotently", async (root, ask) => {
  const issued = writeAskFixture(root);
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => {
    recordEscalationDecision(root, issued, "proceed");
    return submit(questions[0]!, ["proceed"]);
  }, []));
  const details = response.details as { ok?: boolean; already_recorded?: boolean; decision?: string };
  assert.equal(details.ok, true);
  assert.equal(details.already_recorded, true);
  assert.equal(details.decision, "proceed");
  assert.equal(persistedAnswers(root).length, 1, "no duplicate answer is minted for an idempotent replay");
});

withFixture("ask: malformed capabilities fail closed before any human prompt", async (root, ask) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];

  // Cardinality corruption invalidates the whole capability shape.
  overwriteStateFile(root, (raw) => {
    (raw.dispatch_capability as Record<string, unknown>).expected_count = 5;
  });
  let response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  let details = response.details as { ok?: boolean; code?: string; error?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_REJECTED");
  assert.equal(details.error, "dispatch capability unavailable");

  // A tampered dispatch record breaks the capability's dispatch invariants.
  overwriteStateFile(root, (raw) => {
    const cap = raw.dispatch_capability as Record<string, unknown>;
    cap.expected_count = 1;
    (cap.dispatches as Array<Record<string, unknown>>).push({ id: "forged", role: "developer-kotlin#bogus", agent: "ghost", status: "authorized", attempt: 1, created_at: "now" });
  });
  response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  details = response.details as { ok?: boolean; code?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_REJECTED");
  assert.equal(details.error, "dispatch capability unavailable");
  assert.deepEqual(calls, [], "a malformed capability never raises the human dialog");
  assert.equal(persistedRawAnswers(root).length, 0);
});

withFixture("ask: state↔capability drift fails closed before any human prompt", async (root, ask) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];

  // Top-level stage cursor no longer matches the capability binding.
  overwriteStateFile(root, (raw) => {
    raw.stage_cursor = "code_review";
  });
  let response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  let details = response.details as { ok?: boolean; error?: string };
  assert.equal(details.ok, false);
  assert.match(details.error ?? "", /capability stage cursor does not match the workflow state/);

  // Top-level run identity no longer matches the capability binding.
  overwriteStateFile(root, (raw) => {
    raw.stage_cursor = "implementation";
    raw.run_key = "some-other-run";
  });
  response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  details = response.details as { ok?: boolean; error?: string };
  assert.equal(details.ok, false);
  assert.match(details.error ?? "", /capability run_key does not match the workflow state/);

  // A branch switch underneath the run makes the state stale.
  overwriteStateFile(root, (raw) => {
    raw.run_key = "main";
    raw.branch = "feat/elsewhere";
  });
  response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  details = response.details as { ok?: boolean; error?: string };
  assert.equal(details.ok, false);
  assert.match(details.error ?? "", /stale for the active branch/);
  assert.deepEqual(calls, [], "drifted state never raises the human dialog");
  assert.equal(persistedAnswers(root).length, 0);
});

withFixture("ask: profile drift between the capability binding and the current profile fails closed", async (root, ask) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];
  const driftedHash = "f".repeat(64);
  overwriteStateFile(root, (raw) => {
    raw.profile_hash = driftedHash;
    const cap = raw.dispatch_capability as Record<string, unknown>;
    (cap.issued_for as Record<string, unknown>).profile_hash = driftedHash;
  });
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const details = response.details as { ok?: boolean; error?: string };
  assert.equal(details.ok, false);
  assert.match(details.error ?? "", /workflow profile hash drifted from the capability binding/);
  assert.deepEqual(calls, []);
  assert.equal(persistedAnswers(root).length, 0);
});

withFixture("ask: policy drift between the persisted state and the declaring profile fails closed", async (root, ask) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];
  // Sanity: the fixture persists the profile-derived checkpoint policy.
  assert.ok(readStateFile(root).checkpoint_policy, "the normalized fixture persists the profile checkpoint policy");
  overwriteStateFile(root, (raw) => {
    const policy = raw.checkpoint_policy as Record<string, unknown>;
    const rules = policy.rules as Record<string, Record<string, unknown>>;
    rules.approve_implementation.allowed_decisions = ["proceed", "reject", "ship_it"];
  });
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["ship_it"]), calls));
  const details = response.details as { ok?: boolean; error?: string };
  assert.equal(details.ok, false);
  assert.match(details.error ?? "", /checkpoint policy drifted between the workflow state and the declaring profile/);
  assert.deepEqual(calls, []);
  assert.equal(persistedAnswers(root).length, 0);
});

withFixture("ask: exact replay of a live identical answer re-issues the same proof without minting", async (root, ask) => {
  const issued = writeAskFixture(root);
  seedLiveAnswer(root, "terminal/main/implementation/approve_implementation/1", "proceed");
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), []));
  const details = response.details as { ok?: boolean; decision?: string; error?: string; actor_provenance?: { proof?: { answer_id?: string } } };
  assert.equal(details.ok, true, details.error);
  assert.equal(details.decision, "proceed");
  assert.equal(details.actor_provenance?.proof?.answer_id, "terminal/main/implementation/approve_implementation/1", "the existing live proof identity is reused");
  const answers = persistedAnswers(root);
  assert.equal(answers.length, 1, "no second live answer is minted");
  assert.equal(answers[0]?.consumed_at, undefined, "the reused proof stays live for the follow-up workflow_checkpoint call");
});

withFixture("ask: a conflicting selection supersedes the stale live proof and mints exactly one fresh answer", async (root, ask) => {
  const issued = writeAskFixture(root);
  seedLiveAnswer(root, "terminal/main/implementation/approve_implementation/1", "proceed");
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["reject"]), []));
  const details = response.details as { ok?: boolean; decision?: string; error?: string; actor_provenance?: { proof?: { answer_id?: string } } };
  assert.equal(details.ok, true, details.error);
  assert.equal(details.decision, "reject");
  assert.notEqual(details.actor_provenance?.proof?.answer_id, "terminal/main/implementation/approve_implementation/1");
  const answers = persistedAnswers(root);
  assert.equal(answers.length, 2);
  const unconsumed = answers.filter((answer) => !answer.consumed_at);
  assert.equal(unconsumed.length, 1, "at most one unconsumed answer exists per unresolved checkpoint");
  assert.equal(unconsumed[0]?.decision, "reject");
  assert.ok(answers.find((answer) => answer.answer_id === "terminal/main/implementation/approve_implementation/1")?.consumed_at, "the superseded proof is consumed");
});

withFixture("ask: pre-existing duplicate live proofs collapse to one when the identical answer is replayed", async (root, ask) => {
  const issued = writeAskFixture(root);
  seedLiveAnswers(root, [
    { answerId: "terminal/main/implementation/approve_implementation/1", decision: "proceed" },
    { answerId: "terminal/main/implementation/approve_implementation/2", decision: "reject" },
  ]);
  assert.equal(persistedAnswers(root).length, 2, "scenario setup wrote two live proofs");
  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), []));
  const details = response.details as { ok?: boolean; error?: string; actor_provenance?: { proof?: { answer_id?: string } } };
  assert.equal(details.ok, true, details.error);
  assert.equal(details.actor_provenance?.proof?.answer_id, "terminal/main/implementation/approve_implementation/1", "the identical live proof is reused");
  const answers = persistedAnswers(root);
  const unconsumed = answers.filter((answer) => !answer.consumed_at);
  assert.equal(unconsumed.length, 1, "the duplicate sibling proof is superseded");
  assert.equal(unconsumed[0]?.answer_id, "terminal/main/implementation/approve_implementation/1");
  assert.ok(answers.find((answer) => answer.answer_id === "terminal/main/implementation/approve_implementation/2")?.consumed_at);
});

withFixture("ask: malformed host results record nothing", async (root, ask) => {
  const issued = writeAskFixture(root);
  const cases: Array<[string, (question: DialogQuestion) => unknown]> = [
    ["canceled dialog", () => undefined],
    ["chat redirect", () => ({ kind: "chat" })],
    ["zero answer items", () => ({ kind: "submit", results: [] })],
    ["extra answer items", (question) => ({
      kind: "submit",
      results: [
        { ...canonicalItem(question), selectedOptions: ["proceed"] },
        { ...canonicalItem(question), selectedOptions: ["reject"] },
      ],
    })],
    ["wrong question id", (question) => submit(question, ["proceed"], { id: "checkpoint:other" })],
    ["missing question echo", (question) => withoutEcho(question, "question")],
    ["mismatched question echo", (question) => submit(question, ["proceed"], { question: "a different question" })],
    ["missing options echo", (question) => withoutEcho(question, "options")],
    ["mismatched options echo", (question) => submit(question, ["proceed"], { options: ["proceed", "reject", "ship_it"] })],
    ["reordered options echo", (question) => submit(question, ["proceed"], { options: ["reject", "proceed"] })],
    ["missing multi flag", (question) => withoutEcho(question, "multi")],
    ["multi answer", (question) => submit(question, ["proceed"], { multi: true })],
    ["two selections", (question) => submit(question, ["proceed", "reject"])],
    ["non-string selection", (question) => ({ kind: "submit", results: [{ ...canonicalItem(question), selectedOptions: [7] }] })],
    ["timeout", (question) => submit(question, ["proceed"], { timedOut: true })],
    ["non-boolean timeout", (question) => submit(question, ["proceed"], { timedOut: "yes" })],
    ["custom input", (question) => submit(question, [], { customInput: "make it so" })],
    ["non-string custom input", (question) => submit(question, [], { customInput: 42 })],
    ["non-string note", (question) => submit(question, ["proceed"], { note: 9 })],
    ["unknown metadata", (question) => ({ kind: "submit", results: [{ ...canonicalItem(question), selectedOptions: ["proceed"], injected: true }] })],
    ["unknown option", (question) => submit(question, ["ship it"])],
  ];
  for (const [label, script] of cases) {
    const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => script(questions[0]!), []));
    const details = response.details as { ok?: boolean; code?: string; error?: string };
    assert.equal(details.ok, false, `${label} must not authorize`);
    assert.equal(details.code, "WORKFLOW_CHECKPOINT_DECLINED", `${label}: ${details.error}`);
    assert.equal(persistedAnswers(root).length, 0, `${label} must not ingest an answer`);
  }
});

withFixture("ask: headless sessions keep failing closed without an interactive surface", async (root, ask) => {
  const issued = writeAskFixture(root);
  const response = await ask("t", askAuth(issued), undefined, undefined, { cwd: root, hasUI: true });
  const details = response.details as { ok?: boolean; code?: string };
  assert.equal(details.ok, false);
  assert.equal(details.code, "WORKFLOW_CHECKPOINT_ASK_UNAVAILABLE");
  assert.equal(persistedAnswers(root).length, 0);
});

withFixture("ask: loop_iteration is enforced before any dialog and propagates into the payload and ledger", async (root, ask, tools) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];

  // A mismatched iteration is a binding mismatch and never raises the dialog.
  const mismatched = await ask("t", { ...askAuth(issued), loop_iteration: 2 }, undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const mismatchedDetails = mismatched.details as { ok?: boolean; code?: string; error?: string };
  assert.equal(mismatchedDetails.ok, false);
  assert.equal(mismatchedDetails.code, "WORKFLOW_CHECKPOINT_ASK_REJECTED");
  assert.match(mismatchedDetails.error ?? "", /capability binding mismatch/);
  assert.deepEqual(calls, [], "a mismatched loop iteration never raises the human dialog");
  assert.equal(persistedAnswers(root).length, 0);

  // The matching handoff iteration commits and is echoed verbatim.
  const first = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const firstDetails = first.details as { ok?: boolean; error?: string; loop_iteration?: number; actor_provenance?: { ref: string; proof: { answer_id: string; nonce: string; channel: string; reference: string; binding: string } } };
  assert.equal(firstDetails.ok, true, firstDetails.error);
  assert.equal(firstDetails.loop_iteration, 1, "the validated handoff iteration is echoed for the verbatim follow-up call");

  // The follow-up workflow_checkpoint records under the same loop scope.
  const checkpointTool = tools.get("workflow_checkpoint");
  assert.ok(checkpointTool, "workflow_checkpoint must be registered");
  const checkpoint = checkpointTool.execute as unknown as AskExecute;
  const recorded = await checkpoint("t", {
    ...checkpointEnvelope(issued),
    actor_provenance: firstDetails.actor_provenance,
    decision: "proceed",
    rationale: "approved with the loop-scoped binding",
  }, undefined, undefined, { cwd: root });
  assert.equal((recorded.details as { ok?: boolean; error?: string }).ok, true, (recorded.details as { error?: string }).error);
  const decisions = readStateFile(root).typed_checkpoint_decisions ?? [];
  assert.equal(decisions.length, 1);
  assert.equal((decisions[0] as unknown as { loop_iteration?: number }).loop_iteration, 1, "the ledger decision carries the handoff loop iteration");

  // A re-ask with the same iteration short-circuits without a dialog.
  const callsBefore = calls.length;
  const replay = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const replayDetails = replay.details as { ok?: boolean; already_recorded?: boolean };
  assert.equal(replayDetails.ok, true);
  assert.equal(replayDetails.already_recorded, true);
  assert.equal(calls.length, callsBefore, "the resolved checkpoint never re-raises the dialog");
});

withFixture("ask: a live escalation proof is superseded across channels and can never authorize the follow-up workflow_checkpoint", async (root, ask, tools) => {
  const issued = writeAskFixture(root);
  // Another trusted surface (escalation) minted a live proof for a different decision.
  const resolved = resolveState(root);
  assert.ok(resolved.state);
  const escalation = recordTrustedCheckpointAnswer(resolved.state, {
    answer_id: "escalation/main/implementation/approve_implementation/1",
    channel: "escalation",
    reference: "escalation-answer/main/implementation/approve_implementation/1",
    stage_id: "implementation",
    checkpoint_id: "approve_implementation",
    decision: "proceed",
  });
  writeStateBootstrap(root, escalation.state, { target: resolved });
  const staleProof = escalation.proof;

  const response = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["reject"]), []));
  const details = response.details as { ok?: boolean; decision?: string; error?: string; actor_provenance?: { ref: string; proof: { answer_id: string; nonce: string; channel: string; reference: string; binding: string } } };
  assert.equal(details.ok, true, details.error);
  assert.equal(details.decision, "reject");
  const answers = persistedAnswers(root);
  assert.equal(answers.length, 2);
  const unconsumed = answers.filter((answer) => !answer.consumed_at);
  assert.equal(unconsumed.length, 1, "exactly one live answer survives across both channels");
  assert.equal(unconsumed[0]?.channel, "terminal");
  assert.equal(unconsumed[0]?.answer_id, details.actor_provenance?.proof?.answer_id);
  assert.ok(answers.find((answer) => answer.answer_id === staleProof.answer_id)?.consumed_at, "the escalation proof is superseded");

  // The superseded escalation proof can never authorize the follow-up decision.
  const checkpointTool = tools.get("workflow_checkpoint");
  assert.ok(checkpointTool, "workflow_checkpoint must be registered");
  const checkpoint = checkpointTool.execute as unknown as AskExecute;
  const superseded = await checkpoint("t", {
    ...checkpointEnvelope(issued),
    actor_provenance: { kind: "user", ref: staleProof.reference, proof: staleProof },
    decision: "proceed",
    rationale: "stale escalation replay",
  }, undefined, undefined, { cwd: root });
  const supersededDetails = superseded.details as { ok?: boolean; error?: string };
  assert.equal(supersededDetails.ok, false, "a superseded proof must not authorize");
  assert.match(supersededDetails.error ?? "", /superseded by a newer answer/);

  const fresh = await checkpoint("t", {
    ...checkpointEnvelope(issued),
    actor_provenance: { kind: "user", ref: details.actor_provenance!.ref, proof: details.actor_provenance!.proof },
    decision: "reject",
    rationale: "terminal answer",
  }, undefined, undefined, { cwd: root });
  assert.equal((fresh.details as { ok?: boolean; error?: string }).ok, true, (fresh.details as { error?: string }).error);
});

withFixture("ask: exact decision replay stays idempotent and a mismatched replay of the consumed proof is rejected", async (root, ask, tools) => {
  const issued = writeAskFixture(root);
  const calls: DialogCall[] = [];
  const first = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const firstDetails = first.details as { ok?: boolean; actor_provenance?: unknown; error?: string };
  assert.equal(firstDetails.ok, true, firstDetails.error);

  const checkpointTool = tools.get("workflow_checkpoint");
  assert.ok(checkpointTool, "workflow_checkpoint must be registered");
  const checkpoint = checkpointTool.execute as unknown as AskExecute;
  const envelope = checkpointEnvelope(issued);
  const mismatched = await checkpoint("t", { ...envelope, actor_provenance: firstDetails.actor_provenance, decision: "reject", rationale: "mismatched replay" }, undefined, undefined, { cwd: root });
  const mismatchedDetails = mismatched.details as { ok?: boolean; error?: string };
  assert.equal(mismatchedDetails.ok, false, "a consumed/used proof must not authorize a different decision");
  assert.match(mismatchedDetails.error ?? "", /stale or mismatched/);

  const exact = await checkpoint("t", { ...envelope, actor_provenance: firstDetails.actor_provenance, decision: "proceed", rationale: "exact idempotent replay" }, undefined, undefined, { cwd: root });
  assert.equal((exact.details as { ok?: boolean; error?: string }).ok, true, (exact.details as { error?: string }).error);

  // Re-ask after the decision is recorded: no new dialog, idempotent short-circuit.
  const callsBefore = calls.length;
  const replay = await ask("t", askAuth(issued), undefined, undefined, askContext(root, (questions) => submit(questions[0]!, ["proceed"]), calls));
  const replayDetails = replay.details as { ok?: boolean; already_recorded?: boolean; decision?: string; error?: string };
  assert.equal(replayDetails.ok, true, replayDetails.error);
  assert.equal(replayDetails.already_recorded, true);
  assert.equal(replayDetails.decision, "proceed");
  assert.equal(calls.length, callsBefore, "the resolved checkpoint never re-raises the dialog");
  assert.equal((readStateFile(root).typed_checkpoint_decisions ?? []).length, 1, "the ledger keeps exactly one decision");
});
