/* <!-- omp-cto-slice run=01a03ee4-7dd6-7580-8ad7-16d26dc886ba slice=workflow-v2-fullstack --> */

import {
  isCanonicalRoot,
  isTrustedFsAuthority,
  validateWorkflowRunIdentity,
  type AgentInventoryReservation,
  type CanonicalRoot,
  type Escalation,
  type EscalationAnswer,
  type EscalationAdapter,
  type EscalationInboundMessage,
  type EscalationReceipt,
  type TrustedFsAuthority,
  type WorkflowRunIdentity,
} from "@andvl1/omp-workflows-core";
import {
  isFullstackStorageAuthority,
  type FullstackStorageAuthority,
  type StorageEntry,
} from "../storage-authority.js";

/** Test-only durable layout relative to the injected storage authority. */
export interface MockPersistedOptions {
  readonly relative_dir: string;
}

export interface MockEscalationAdapterOptions {
  readonly project_root: CanonicalRoot;
  readonly run_identity: WorkflowRunIdentity;
  readonly filesystem_authority?: TrustedFsAuthority;
  readonly storage?: FullstackStorageAuthority;
  readonly agent_inventory_authority?: "omp";
  readonly agent_inventory_fingerprint?: `sha256:${string}`;
  readonly agent_inventory_reservation?: AgentInventoryReservation;
  readonly autoAnswer?: (esc: Escalation) => string | null;
  readonly persisted?: MockPersistedOptions;
}

const MAX_INBOX_TEXT_LENGTH = 4_000;
const MAX_RECORD_BYTES = 4 * 1024 * 1024;
const MAX_JSON_DEPTH = 64;
const MAX_DIRECTORY_ENTRIES = 512;
const MAX_APPEND_BYTES = 16 * 1024 * 1024;
const MAX_PATH_COMPONENT = 255;

type PlainMessageHandler = (message: EscalationInboundMessage) => Promise<void>;

function sameRun(left: WorkflowRunIdentity, right: WorkflowRunIdentity): boolean {
  return left.root_instance_id === right.root_instance_id
    && left.provider_id === right.provider_id
    && left.descriptor_fingerprint === right.descriptor_fingerprint
    && left.executable_provenance.build_fingerprint === right.executable_provenance.build_fingerprint
    && left.executable_provenance.runtime_fingerprint === right.executable_provenance.runtime_fingerprint
    && left.catalog_content_digest === right.catalog_content_digest
    && left.config_byte_sha256 === right.config_byte_sha256
    && left.config_semantic_sha256 === right.config_semantic_sha256
    && left.session.session_id === right.session.session_id
    && left.session.lifecycle_id === right.session.lifecycle_id
    && left.run_id === right.run_id
    && left.profile_identity.id === right.profile_identity.id
    && left.profile_identity.fingerprint === right.profile_identity.fingerprint;
}

function validRelative(value: string): boolean {
  return typeof value === "string" && value.length > 0 && value.length <= 1_024 && !value.startsWith("/") && !value.includes("\\") && value.split("/").every((part) => part.length > 0 && part.length <= MAX_PATH_COMPONENT && part !== "." && part !== ".." && /^[A-Za-z0-9._-]+$/u.test(part));
}

function encodedKey(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

function bytesOf(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  if (!value || typeof value !== "object") throw new TypeError("non-JSON record");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

function exactRecord(left: unknown, right: unknown): boolean {
  try { return canonicalJson(left) === canonicalJson(right); } catch { return false; }
}

function assertOptions(options: MockEscalationAdapterOptions): void {
  if (!options || !isCanonicalRoot(options.project_root) || !options.run_identity || typeof options.run_identity !== "object") throw new TypeError("MockEscalationAdapter requires an explicit canonical root and run identity");
  if (options.persisted && !isTrustedFsAuthority(options.filesystem_authority)) throw new TypeError("MockEscalationAdapter persisted mode requires the launcher-issued filesystem authority");
  if (options.persisted && !isFullstackStorageAuthority(options.storage)) throw new TypeError("MockEscalationAdapter persisted mode requires the injected FullstackStorageAuthority");
  if (options.storage && (options.storage.project_root !== options.project_root || !sameRun(options.storage.run_identity, options.run_identity))) throw new TypeError("MockEscalationAdapter storage must be pinned to the exact root and run");
  if (options.persisted && !validRelative(options.persisted.relative_dir)) throw new TypeError("MockEscalationAdapter persisted relative_dir is unsafe");
}

/**
 * Test-only deterministic transport. It is never a registry builtin and all
 * durable behavior is delegated to an explicitly injected storage capability.
 */
export class MockEscalationAdapter implements EscalationAdapter {
  readonly kind = "mock";
  readonly sentEscalations: Escalation[] = [];

  private readonly runIdentity: WorkflowRunIdentity;
  private readonly storage?: FullstackStorageAuthority;
  private readonly autoAnswer?: (esc: Escalation) => string | null;
  private readonly persisted?: MockPersistedOptions;
  private queuedAnswers: EscalationAnswer[] = [];
  private cancelled = new Set<string>();
  private readonly inboundInFlight = new Set<string>();
  private plainHandler: PlainMessageHandler | null = null;
  private readonly plainTextLog: Array<{ target: string; text: string; at: string }> = [];
  private counter = 0;
  private closed = false;

  constructor(options: MockEscalationAdapterOptions) {
    assertOptions(options);
    this.runIdentity = options.run_identity;
    this.storage = options.storage;
    this.autoAnswer = options.autoAnswer;
    this.persisted = options.persisted;
  }

  async send(escalation: Escalation): Promise<EscalationReceipt> {
    if (this.closed || !sameRun(escalation.run_identity, this.runIdentity)) return { sent: false, run_identity: this.runIdentity, channelRef: "mock:identity-mismatch" };
    try {
      if (this.persisted) {
        const persisted = this.appendOutboundMessage(escalation);
        if (!persisted) return { sent: false, run_identity: this.runIdentity, channelRef: "mock:persistence-failed" };
      }
      this.sentEscalations.push(escalation);
      if (this.autoAnswer) {
        const answer = this.autoAnswer(escalation);
        if (typeof answer === "string") this.queueAnswer(escalation.id, answer, "mock");
      }
      return { sent: true, run_identity: this.runIdentity, channelRef: `mock:${escalation.id}` };
    } catch {
      return { sent: false, run_identity: this.runIdentity, channelRef: "mock:persistence-failed" };
    }
  }

  async cancel(id: string): Promise<void> {
    if (!this.closed && typeof id === "string" && id.startsWith(`${this.runIdentity.run_id}/`)) this.cancelled.add(id);
  }

  async pollOnce(): Promise<EscalationAnswer[]> {
    if (this.closed) return [];
    const fromDisk = this.persisted ? this.drainPersistedAnswers() : [];
    const merged = new Map<string, EscalationAnswer>();
    for (const answer of fromDisk) merged.set(answer.id, answer);
    for (const answer of this.queuedAnswers) merged.set(answer.id, answer);
    this.queuedAnswers = [];
    if (this.persisted) await this.drainPersistedInbound();
    return [...merged.values()].map((answer) => this.cancelled.has(answer.id) ? { ...answer, stale: true } : answer);
  }

  setPlainMessageHandler(handler: PlainMessageHandler): void {
    this.plainHandler = handler;
  }

  async sendPlainText(target: string, text: string): Promise<{ sent: boolean; channelRef?: string }> {
    if (this.closed || typeof target !== "string" || target.length === 0 || typeof text !== "string" || text.length > MAX_INBOX_TEXT_LENGTH) return { sent: false, channelRef: "mock:invalid" };
    const at = new Date().toISOString();
    const channelRef = `mock:plain:${this.nextId()}`;
    if (this.persisted) {
      const line = `${JSON.stringify({ target, text, at, receipt: { sent: true, channelRef, run_identity: this.runIdentity } })}\n`;
      const written = this.storage!.appendJsonLineBounded(this.path("outbound/plain.jsonl"), new TextEncoder().encode(line), MAX_APPEND_BYTES);
      if (!written.ok) return { sent: false, channelRef: "mock:persistence-failed" };
    }
    this.plainTextLog.push({ target, text, at });
    return { sent: true, channelRef };
  }

  injectAnswer(id: string, answer: string, by = "mock"): void {
    if (this.closed || typeof id !== "string" || !id.startsWith(`${this.runIdentity.run_id}/`) || typeof answer !== "string" || answer.trim().length === 0 || answer.length > MAX_INBOX_TEXT_LENGTH) return;
    this.queueAnswer(id, answer, by);
  }

  async injectPlainMessage(text: string, by = "mock"): Promise<void> {
    await this.injectTask(text, by, "mock:plain");
  }

  async injectTask(text: string, by = "mock", prefix = "mock:task"): Promise<void> {
    if (this.closed || typeof text !== "string" || text.trim().length === 0 || text.length > MAX_INBOX_TEXT_LENGTH) return;
    const message: EscalationInboundMessage & { readonly by: string } = {
      run_identity: this.runIdentity,
      id: `${prefix}:${this.nextId()}`,
      text,
      at: new Date().toISOString(),
      by,
    };
    let sourcePath: string | undefined;
    if (this.persisted) {
      const written = this.persistRecord("inbound", "task", message);
      if (!written) return;
      sourcePath = this.path(`inbound/task-${encodedKey(message.id)}.json`);
    }
    if (!this.plainHandler) return;
    if (sourcePath) this.inboundInFlight.add(sourcePath);
    try {
      await this.plainHandler(message);
    } finally {
      if (sourcePath) this.inboundInFlight.delete(sourcePath);
    }
  }
  /** Test reset clears only memory; durable records remain under their owner for replay. */
  reset(): void {
    this.sentEscalations.length = 0;
    this.queuedAnswers = [];
    this.cancelled.clear();
    this.inboundInFlight.clear();
    this.plainHandler = null;
    this.plainTextLog.length = 0;
    this.counter = 0;
    this.closed = false;
  }

  async shutdown(): Promise<void> {
    this.closed = true;
    this.plainHandler = null;
    this.queuedAnswers = [];
  }

  private path(relative: string): string {
    if (!this.persisted || !validRelative(relative)) throw new Error("mock storage path is unsafe");
    return `${this.persisted.relative_dir}/${relative}`;
  }

  private persistRecord(directory: "inbound" | "answers", prefix: string, data: unknown): boolean {
    const record = data as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id : `${prefix}:${this.nextId()}`;
    const relative = this.path(`${directory}/${prefix}-${encodedKey(id)}.json`);
    const written = this.storage!.writeJsonExclusive(relative, bytesOf(data));
    if (written.ok) return true;
    const existing = this.storage!.readJsonBounded(relative, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
    return existing.ok && existing.value !== null && exactRecord(existing.value, data);
  }

  private queueAnswer(id: string, answer: string, by: string): void {
    const record: EscalationAnswer = { id, answer, at: new Date().toISOString(), by, run_identity: this.runIdentity };
    if (this.persisted && !this.persistRecord("answers", "answer", record)) return;
    this.queuedAnswers.push(record);
  }

  private appendOutboundMessage(escalation: Escalation): boolean {
    const envelope = escalation as Escalation & { intent?: string; topic?: string };
    const line = `${JSON.stringify({
      escId: escalation.id,
      intent: envelope.intent,
      topic: envelope.topic,
      title: escalation.title,
      body: escalation.body,
      at: new Date().toISOString(),
      run_identity: this.runIdentity,
      receipt: { sent: true, channelRef: `mock:${escalation.id}`, run_identity: this.runIdentity },
    })}\n`;
    const result = this.storage!.appendJsonLineBounded(this.path("outbound/messages.jsonl"), new TextEncoder().encode(line), MAX_APPEND_BYTES);
    return result.ok;
  }

  private drainPersistedAnswers(): EscalationAnswer[] {
    const entries = this.storage!.listJsonBounded(this.path("answers"), MAX_DIRECTORY_ENTRIES);
    if (!entries.ok) return [];
    const out: EscalationAnswer[] = [];
    for (const entry of entries.value) {
      const raw = this.storage!.readJsonBounded(entry.relative_path, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
      if (!raw.ok || raw.value === null) {
        this.quarantine(entry, "answers");
        continue;
      }
      const value = raw.value as Partial<EscalationAnswer>;
      if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 512
        || typeof value.answer !== "string" || value.answer.trim().length === 0 || value.answer.length > MAX_INBOX_TEXT_LENGTH
        || typeof value.at !== "string" || value.at.length === 0
        || typeof value.by !== "string" || value.by.length === 0 || value.by.length > MAX_INBOX_TEXT_LENGTH) {
        this.quarantine(entry, "answers");
        continue;
      }
      const run = validateWorkflowRunIdentity(value.run_identity);
      if (!run.ok || !sameRun(run.value, this.runIdentity)) {
        this.quarantine(entry, "answers");
        continue;
      }
      const moved = this.storage!.moveExclusive(entry.relative_path, this.path(`answers/processed/${entry.name}`));
      if (!moved.ok) continue;
      out.push({ id: value.id, answer: value.answer, at: value.at, by: value.by, run_identity: this.runIdentity });
    }
    return out;
  }

  private async drainPersistedInbound(): Promise<void> {
    const entries = this.storage!.listJsonBounded(this.path("inbound"), MAX_DIRECTORY_ENTRIES);
    if (!entries.ok) return;
    for (const entry of entries.value) {
      const raw = this.storage!.readJsonBounded(entry.relative_path, MAX_RECORD_BYTES, MAX_JSON_DEPTH);
      if (!raw.ok || raw.value === null) {
        this.quarantine(entry, "inbound");
        continue;
      }
      const value = raw.value as Partial<EscalationInboundMessage> & { by?: unknown };
      if (typeof value.id !== "string" || value.id.length === 0 || value.id.length > 512
        || typeof value.text !== "string" || value.text.trim().length === 0 || value.text.length > MAX_INBOX_TEXT_LENGTH
        || typeof value.at !== "string" || value.at.length === 0) {
        this.quarantine(entry, "inbound");
        continue;
      }
      const run = validateWorkflowRunIdentity(value.run_identity);
      if (!run.ok || !sameRun(run.value, this.runIdentity)) {
        this.quarantine(entry, "inbound");
        continue;
      }
      if (!this.plainHandler || this.inboundInFlight.has(entry.relative_path)) continue;
      this.inboundInFlight.add(entry.relative_path);
      try {
        await this.plainHandler({ id: value.id, text: value.text, at: value.at, run_identity: this.runIdentity, ...(typeof value.by === "string" ? { by: value.by } : {}) });
      } catch {
        continue;
      } finally {
        this.inboundInFlight.delete(entry.relative_path);
      }
      this.storage!.moveExclusive(entry.relative_path, this.path(`inbound/processed/${entry.name}`));
    }
  }

  private quarantine(entry: StorageEntry, directory: "answers" | "inbound"): void {
    const digest = Buffer.from(`${directory}:${entry.name}`, "utf8").toString("base64url").slice(0, 32);
    this.storage!.moveExclusive(entry.relative_path, this.path(`${directory}/quarantine/${entry.name}.${digest}.json`));
  }

  private nextId(): number {
    this.counter += 1;
    return this.counter;
  }
}
