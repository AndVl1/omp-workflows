import { createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { TextDecoder } from "node:util";
import { canonicalJson, isSafeFeatureId, isSha256Hex, sha256Hex } from "../specification/validation.js";
import { PinnedRootError, PinnedProjectRoot } from "../specification/pinned-root.js";
import { isSafeCtoExecutionId, isSafeCtoRunId } from "../cto/state.js";
import { deriveRuntimeSecretKey, readOrCreateRootRuntimeSecret } from "../runtime-secret.js";
import type { TrustedCheckpointAnswer } from "./types.js";

const SCHEMA_VERSION = 1 as const;
const DOMAIN = "cto-mapping-confirmation-v1";
const MAX_BYTES = 256 * 1024;
const SAFE_PROOF = /^[a-f0-9]{64}$/u;
const SAFE_STAGE = /^[A-Za-z0-9._:-]{1,128}$/u;
const MAX_TEXT_BYTES = 4096;
const PROOF_DIRECTORY = ".work-state/cto";

export type CtoMappingConfirmationContext = {
  feature_id: string;
  run_key: string;
  stage_id: string;
  decision: "approve_continue";
  capability_id: string;
  capability_epoch: string;
  policy_hash: string;
};

export type CtoMappingConfirmationProofAnswer = TrustedCheckpointAnswer & {
  subject_binding: string;
  subject_revision: number;
  authority_receipt: string;
  consumed_at: string;
};

export type CtoMappingConfirmationProof = {
  schema_version: typeof SCHEMA_VERSION;
  root_identity: { canonical_path: string; dev: number; ino: number };
  cto_run_id: string;
  mapping_id: string;
  mapping_hash: string;
  mapping_version: number;
  proof_ref: string;
  mapping_record_path: string;
  mapping_record_digest: string;
  state_path: string;
  state_after_digest: string;
  checkpoint_ref: string;
  trusted_answer_ref: string;
  confirmation_context: CtoMappingConfirmationContext;
  confirmed_at: string;
  trusted_answer: CtoMappingConfirmationProofAnswer;
  proof_hmac: string;
};

export type CtoMappingConfirmationProofPayload = Omit<CtoMappingConfirmationProof, "proof_hmac">;

type UnsignedProof = CtoMappingConfirmationProofPayload;

export type CtoMappingConfirmationProofReadResult =
  | { ok: true; proof: CtoMappingConfirmationProof; content: string; digest: string; dev: number; ino: number }
  | { ok: false; code: "absent" | "invalid"; error: string };

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value: Record<string, unknown>, required: readonly string[], optional: readonly string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  const keys = Object.keys(value);
  return keys.length >= required.length
    && required.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function text(value: unknown, max = MAX_TEXT_BYTES): value is string {
  return typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= max
    && !/[\u0000-\u001f\u007f\p{Cf}\p{Zl}\p{Zp}]/u.test(value);
}

function safeStage(value: unknown): value is string {
  return typeof value === "string" && SAFE_STAGE.test(value);
}

function relativePath(value: unknown): value is string {
  return text(value, MAX_TEXT_BYTES)
    && value.startsWith(".work-state/")
    && !value.includes("\\")
    && !value.split("/").some((part) => part === "" || part === "." || part === "..");
}

function answerShape(value: unknown): value is CtoMappingConfirmationProofAnswer {
  if (!plain(value)
    || !exactKeys(value,
      ["answer_id", "nonce", "channel", "reference", "run_id", "stage_id", "checkpoint_id", "work_identity_hash", "capability_id", "capability_epoch", "policy_hash", "subject_binding", "subject_revision", "decision", "binding", "authority_receipt", "issued_at", "consumed_at"],
      ["feature_id", "loop_iteration", "feedback"])
    || !isSafeCtoExecutionId(value.answer_id)
    || !text(value.nonce)
    || (value.channel !== "terminal" && value.channel !== "escalation")
    || !text(value.reference)
    || !isSafeCtoRunId(value.run_id)
    || !safeStage(value.stage_id)
    || !text(value.checkpoint_id)
    || typeof value.work_identity_hash !== "string" || !SAFE_PROOF.test(value.work_identity_hash)
    || !isSafeCtoExecutionId(value.capability_id)
    || !isSafeCtoExecutionId(value.capability_epoch)
    || typeof value.policy_hash !== "string" || !SAFE_PROOF.test(value.policy_hash)
    || !isSafeFeatureId(value.feature_id)
    || typeof value.subject_binding !== "string" || !SAFE_PROOF.test(value.subject_binding)
    || !Number.isSafeInteger(value.subject_revision) || (value.subject_revision as number) < 1
    || !text(value.decision, 256)
    || (value.feedback !== undefined && !text(value.feedback, 16 * 1024))
    || typeof value.binding !== "string" || !SAFE_PROOF.test(value.binding)
    || !text(value.authority_receipt)
    || !text(value.issued_at)
    || !text(value.consumed_at)) return false;
  if (value.loop_iteration !== undefined && (!Number.isSafeInteger(value.loop_iteration) || (value.loop_iteration as number) < 1)) return false;
  if (value.decision !== "approve_continue" || value.feedback !== undefined) return false;
  return true;
}

function proofShape(value: unknown, allowUnsigned = false): value is CtoMappingConfirmationProof {
  if (!plain(value)
    || !exactKeys(value, ["schema_version", "root_identity", "cto_run_id", "mapping_id", "mapping_hash", "mapping_version", "proof_ref", "mapping_record_path", "mapping_record_digest", "state_path", "state_after_digest", "checkpoint_ref", "trusted_answer_ref", "confirmation_context", "confirmed_at", "trusted_answer", "proof_hmac"])
    || value.schema_version !== SCHEMA_VERSION
    || !plain(value.root_identity)
    || !exactKeys(value.root_identity, ["canonical_path", "dev", "ino"])
    || !text(value.root_identity.canonical_path, 16 * 1024)
    || !Number.isSafeInteger(value.root_identity.dev) || (value.root_identity.dev as number) < 0
    || !Number.isSafeInteger(value.root_identity.ino) || (value.root_identity.ino as number) < 0
    || !isSafeCtoRunId(value.cto_run_id)
    || !isSafeCtoExecutionId(value.mapping_id)
    || !isSha256Hex(value.mapping_hash)
    || !Number.isSafeInteger(value.mapping_version) || (value.mapping_version as number) < 1
    || !isSafeCtoExecutionId(value.proof_ref)
    || !relativePath(value.mapping_record_path)
    || !isSha256Hex(value.mapping_record_digest)
    || !relativePath(value.state_path)
    || !isSha256Hex(value.state_after_digest)
    || !text(value.checkpoint_ref)
    || !isSafeCtoExecutionId(value.trusted_answer_ref)
    || !plain(value.confirmation_context)
    || !exactKeys(value.confirmation_context, ["feature_id", "run_key", "stage_id", "decision", "capability_id", "capability_epoch", "policy_hash"])
    || !isSafeFeatureId(value.confirmation_context.feature_id)
    || !isSafeCtoRunId(value.confirmation_context.run_key)
    || !safeStage(value.confirmation_context.stage_id)
    || value.confirmation_context.decision !== "approve_continue"
    || !isSafeCtoExecutionId(value.confirmation_context.capability_id)
    || !isSafeCtoExecutionId(value.confirmation_context.capability_epoch)
    || !isSha256Hex(value.confirmation_context.policy_hash)
    || !text(value.confirmed_at)
    || !answerShape(value.trusted_answer)
    || (allowUnsigned ? value.proof_hmac !== "" && (typeof value.proof_hmac !== "string" || !SAFE_PROOF.test(value.proof_hmac)) : (typeof value.proof_hmac !== "string" || !SAFE_PROOF.test(value.proof_hmac)))) return false;
  return true;
}

function unsignedShape(value: unknown): value is UnsignedProof {
  if (!plain(value) || Object.hasOwn(value, "proof_hmac")) return false;
  try { return proofShape({ ...value, proof_hmac: "" }, true); } catch { return false; }
}

function withoutHmac(proof: CtoMappingConfirmationProof): UnsignedProof {
  const { proof_hmac: _proofHmac, ...payload } = proof;
  return payload;
}

function canonicalRecordPath(proof: Pick<CtoMappingConfirmationProof, "cto_run_id" | "mapping_id">): string {
  return `.work-state/cto/${proof.cto_run_id}/specification-mappings/${proof.mapping_id}.json`;
}

function canonicalStatePath(featureId: string): string {
  return `.work-state/features/${featureId}/state.json`;
}

function proofHmac(pinnedRoot: PinnedProjectRoot, payload: UnsignedProof): string | null {
  const master = readOrCreateRootRuntimeSecret(pinnedRoot);
  const key = master ? deriveRuntimeSecretKey(master, DOMAIN) : null;
  if (!key) return null;
  try { return createHmac("sha256", key).update(canonicalJson(payload), "utf8").digest("hex"); } catch { return null; }
}

export function ctoMappingConfirmationStateDigest(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    const serialized = JSON.stringify(value);
    return sha256Hex(typeof serialized === "string" ? serialized : "");
  }
  const copy = { ...(value as Record<string, unknown>) };
  delete copy.updated_at;
  delete copy.state_revision;
  delete copy.control_plane_provenance;
  delete copy.observability;
  return sha256Hex(canonicalJson(copy));
}

export function ctoMappingConfirmationProofRelativePath(ctoRunId: string, mappingId: string, proofRef: string): string | null {
  if (!isSafeCtoRunId(ctoRunId) || !isSafeCtoExecutionId(mappingId) || !isSafeCtoExecutionId(proofRef)) return null;
  const directory = join(PROOF_DIRECTORY, ctoRunId, "artifacts", "mapping-confirmation-proofs", mappingId);
  const path = join(directory, `${proofRef}.json`);
  return path.startsWith(`${directory}/`) ? path : null;
}

export function signCtoMappingConfirmationProof(
  pinnedRoot: PinnedProjectRoot,
  payload: UnsignedProof,
): CtoMappingConfirmationProof | null {
  try {
    if (!unsignedShape(payload)) return null;
    const proof = { ...payload, proof_hmac: "" } as CtoMappingConfirmationProof;
    if (proof.root_identity.canonical_path !== pinnedRoot.canonical_root
      || proof.root_identity.dev !== pinnedRoot.dev
      || proof.root_identity.ino !== pinnedRoot.ino
      || proof.mapping_record_path !== canonicalRecordPath(proof)
      || proof.state_path !== canonicalStatePath(proof.confirmation_context.feature_id)) return null;
    const signature = proofHmac(pinnedRoot, payload);
    return signature ? { ...proof, proof_hmac: signature } : null;
  } catch { return null; }
}

export function verifyCtoMappingConfirmationProof(
  pinnedRoot: PinnedProjectRoot,
  proof: CtoMappingConfirmationProof,
  expected: UnsignedProof,
): boolean {
  try {
    if (!proofShape(proof)
      || !unsignedShape(expected)
      || proof.root_identity.canonical_path !== pinnedRoot.canonical_root
      || proof.root_identity.dev !== pinnedRoot.dev
      || proof.root_identity.ino !== pinnedRoot.ino
      || proof.mapping_record_path !== canonicalRecordPath(proof)
      || proof.state_path !== canonicalStatePath(proof.confirmation_context.feature_id)
      || canonicalJson(withoutHmac(proof)) !== canonicalJson(expected)) return false;
    const expectedHmac = proofHmac(pinnedRoot, expected);
    if (!expectedHmac || !SAFE_PROOF.test(proof.proof_hmac)) return false;
    const actualBytes = Buffer.from(proof.proof_hmac, "hex");
    const expectedBytes = Buffer.from(expectedHmac, "hex");
    return actualBytes.length === expectedBytes.length && timingSafeEqual(actualBytes, expectedBytes);
  } catch { return false; }
}

function canonicalProofContent(proof: CtoMappingConfirmationProof): string {
  return `${canonicalJson(proof)}\n`;
}

function proofWriteResult(
  pinnedRoot: PinnedProjectRoot,
  relative: string,
  content: string,
): { ok: true; content: string; digest: string; path: string; dev: number; ino: number } | { ok: false; error: string } {
  try {
    const before = pinnedRoot.pathEntryInfo(relative);
    if (!before || before.kind !== "file") return { ok: false, error: "mapping confirmation proof is not a regular file" };
    const current = pinnedRoot.readFile(relative, { maxBytes: MAX_BYTES });
    const after = pinnedRoot.pathEntryInfo(relative);
    if (!after || after.kind !== "file" || before.dev !== current.dev || before.ino !== current.ino || after.dev !== current.dev || after.ino !== current.ino || after.size !== current.bytes.byteLength) return { ok: false, error: "mapping confirmation proof changed while it was read" };
    const currentContent = Buffer.from(current.bytes).toString("utf8");
    if (currentContent !== content) return { ok: false, error: "mapping confirmation proof already exists with different bytes" };
    return { ok: true, content, digest: sha256Hex(content), path: relative, dev: current.dev, ino: current.ino };
  } catch (error) {
    if (!(error instanceof PinnedRootError && error.code === "not_found")) return { ok: false, error: `mapping confirmation proof publication failed: ${error instanceof Error ? error.message : String(error)}` };
  }
  try {
    pinnedRoot.writeExclusive(relative, Buffer.from(content, "utf8"));
    const published = pinnedRoot.readFile(relative, { maxBytes: MAX_BYTES });
    const publishedInfo = pinnedRoot.pathEntryInfo(relative);
    const publishedContent = Buffer.from(published.bytes).toString("utf8");
    if (!publishedInfo || publishedInfo.kind !== "file" || publishedInfo.dev !== published.dev || publishedInfo.ino !== published.ino || publishedInfo.size !== published.bytes.byteLength || publishedContent !== content) return { ok: false, error: "mapping confirmation proof changed during publication" };
    return { ok: true, content, digest: sha256Hex(content), path: relative, dev: published.dev, ino: published.ino };
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "exists") {
      try {
        const before = pinnedRoot.pathEntryInfo(relative);
        const current = pinnedRoot.readFile(relative, { maxBytes: MAX_BYTES });
        const after = pinnedRoot.pathEntryInfo(relative);
        const currentContent = Buffer.from(current.bytes).toString("utf8");
        if (before && after && before.kind === "file" && after.kind === "file" && before.dev === current.dev && before.ino === current.ino && after.dev === current.dev && after.ino === current.ino && after.size === current.bytes.byteLength && currentContent === content) return { ok: true, content, digest: sha256Hex(content), path: relative, dev: current.dev, ino: current.ino };
      } catch { /* report the original conflict below */ }
    }
    return { ok: false, error: `mapping confirmation proof publication failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function writeCtoMappingConfirmationProof(
  pinnedRoot: PinnedProjectRoot,
  proof: CtoMappingConfirmationProof,
): { ok: true; content: string; digest: string; path: string; dev: number; ino: number } | { ok: false; error: string } {
  try {
    if (!verifyCtoMappingConfirmationProof(pinnedRoot, proof, withoutHmac(proof))) return { ok: false, error: "mapping confirmation proof is malformed or authentication failed" };
    const relative = ctoMappingConfirmationProofRelativePath(proof.cto_run_id, proof.mapping_id, proof.proof_ref);
    if (!relative) return { ok: false, error: "mapping confirmation proof path is unsafe" };
    const content = canonicalProofContent(proof);
    if (Buffer.byteLength(content, "utf8") > MAX_BYTES) return { ok: false, error: "mapping confirmation proof exceeds its byte cap" };
    pinnedRoot.ensureDirectories([join(PROOF_DIRECTORY, proof.cto_run_id, "artifacts", "mapping-confirmation-proofs", proof.mapping_id)]);
    return proofWriteResult(pinnedRoot, relative, content);
  } catch (error) {
    return { ok: false, error: `mapping confirmation proof publication failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function readCtoMappingConfirmationProof(
  pinnedRoot: PinnedProjectRoot,
  ctoRunId: string,
  mappingId: string,
  proofRef: string,
  expected: UnsignedProof,
): CtoMappingConfirmationProofReadResult {
  const relative = ctoMappingConfirmationProofRelativePath(ctoRunId, mappingId, proofRef);
  if (!relative) return { ok: false, code: "invalid", error: "mapping confirmation proof selector is unsafe" };
  try {
    if (!pinnedRoot.pathEntryExists(relative)) return { ok: false, code: "absent", error: "mapping confirmation proof is absent" };
    const before = pinnedRoot.pathEntryInfo(relative);
    if (!before || before.kind !== "file") return { ok: false, code: "invalid", error: "mapping confirmation proof is not a regular file" };
    const read = pinnedRoot.readFile(relative, { maxBytes: MAX_BYTES });
    const after = pinnedRoot.pathEntryInfo(relative);
    if (!after || after.kind !== "file" || before.dev !== read.dev || before.ino !== read.ino || after.dev !== read.dev || after.ino !== read.ino || after.size !== read.bytes.byteLength) return { ok: false, code: "invalid", error: "mapping confirmation proof changed while it was read" };
    const info = after;
    const bytes = read.bytes;
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
    catch { return { ok: false, code: "invalid", error: "mapping confirmation proof is not valid UTF-8" }; }
    let parsed: unknown;
    try { parsed = JSON.parse(content) as unknown; } catch { return { ok: false, code: "invalid", error: "mapping confirmation proof is not valid JSON" }; }
    if (!proofShape(parsed)) return { ok: false, code: "invalid", error: "mapping confirmation proof schema is invalid" };
    if (canonicalProofContent(parsed) !== content) return { ok: false, code: "invalid", error: "mapping confirmation proof wire format is noncanonical" };
    if (parsed.cto_run_id !== ctoRunId || parsed.mapping_id !== mappingId || parsed.proof_ref !== proofRef) return { ok: false, code: "invalid", error: "mapping confirmation proof identity is foreign" };
    if (!verifyCtoMappingConfirmationProof(pinnedRoot, parsed, expected)) return { ok: false, code: "invalid", error: "mapping confirmation proof does not match the canonical confirmation image or authentication failed" };
    return { ok: true, proof: parsed, content, digest: sha256Hex(content), dev: info.dev, ino: info.ino };
  } catch (error) {
    return { ok: false, code: "invalid", error: `mapping confirmation proof cannot be read safely: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function removeCtoMappingConfirmationProof(
  pinnedRoot: PinnedProjectRoot,
  proof: Pick<CtoMappingConfirmationProof, "cto_run_id" | "mapping_id" | "proof_ref">,
  expectedContent: string,
): boolean {
  const relative = ctoMappingConfirmationProofRelativePath(proof.cto_run_id, proof.mapping_id, proof.proof_ref);
  if (!relative) return false;
  try {
    const current = pinnedRoot.readFile(relative, { maxBytes: MAX_BYTES });
    if (Buffer.from(current.bytes).toString("utf8") !== expectedContent) return false;
    pinnedRoot.removeFileIfMatches(relative, {
      dev: current.dev,
      ino: current.ino,
      sha256: sha256Hex(expectedContent),
    });
    return true;
  } catch {
    return false;
  }
}
