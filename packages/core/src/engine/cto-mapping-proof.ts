import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { canonicalJson, isSafeFeatureId, isSha256Hex } from "../specification/validation.js";
import { PinnedRootError, PinnedProjectRoot } from "../specification/pinned-root.js";
import { deriveRuntimeSecretKey, readOrCreateRootRuntimeSecret } from "../runtime-secret.js";
import type { TrustedCheckpointAnswer } from "./types.js";

const SCHEMA_VERSION = 1 as const;
const DOMAIN = "cto-mapping-confirmation-v1";
const MAX_BYTES = 256 * 1024;
const SAFE_PROOF = /^[a-f0-9]{64}$/u;
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,256}$/u;
const SAFE_STAGE = /^[A-Za-z0-9._:-]{1,256}$/u;
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
  | { ok: true; proof: CtoMappingConfirmationProof; content: string }
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

function segment(value: unknown): value is string {
  return typeof value === "string" && value !== "." && value !== ".." && SAFE_SEGMENT.test(value);
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
    || !segment(value.answer_id)
    || !text(value.nonce)
    || (value.channel !== "terminal" && value.channel !== "escalation")
    || !text(value.reference)
    || !segment(value.run_id)
    || typeof value.stage_id !== "string" || !SAFE_STAGE.test(value.stage_id)
    || !text(value.checkpoint_id)
    || typeof value.work_identity_hash !== "string" || !SAFE_PROOF.test(value.work_identity_hash)
    || !segment(value.capability_id)
    || !segment(value.capability_epoch)
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
    || !segment(value.cto_run_id)
    || !segment(value.mapping_id)
    || !isSha256Hex(value.mapping_hash)
    || !Number.isSafeInteger(value.mapping_version) || (value.mapping_version as number) < 1
    || !segment(value.proof_ref)
    || !relativePath(value.mapping_record_path)
    || !isSha256Hex(value.mapping_record_digest)
    || !relativePath(value.state_path)
    || !isSha256Hex(value.state_after_digest)
    || !text(value.checkpoint_ref)
    || !segment(value.trusted_answer_ref)
    || !plain(value.confirmation_context)
    || !exactKeys(value.confirmation_context, ["feature_id", "run_key", "stage_id", "decision", "capability_id", "capability_epoch", "policy_hash"])
    || !isSafeFeatureId(value.confirmation_context.feature_id)
    || !segment(value.confirmation_context.run_key)
    || typeof value.confirmation_context.stage_id !== "string" || !SAFE_STAGE.test(value.confirmation_context.stage_id)
    || value.confirmation_context.decision !== "approve_continue"
    || !segment(value.confirmation_context.capability_id)
    || !segment(value.confirmation_context.capability_epoch)
    || !isSha256Hex(value.confirmation_context.policy_hash)
    || !text(value.confirmed_at)
    || !answerShape(value.trusted_answer)
    || (allowUnsigned ? value.proof_hmac !== "" && (typeof value.proof_hmac !== "string" || !SAFE_PROOF.test(value.proof_hmac)) : (typeof value.proof_hmac !== "string" || !SAFE_PROOF.test(value.proof_hmac)))) return false;
  return true;
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
  return createHmac("sha256", key).update(canonicalJson(payload), "utf8").digest("hex");
}

export function ctoMappingConfirmationProofRelativePath(ctoRunId: string, mappingId: string, proofRef: string): string | null {
  if (!segment(ctoRunId) || !segment(mappingId) || !segment(proofRef)) return null;
  const directory = join(PROOF_DIRECTORY, ctoRunId, "artifacts", "mapping-confirmation-proofs", mappingId);
  const path = join(directory, `${proofRef}.json`);
  return path.startsWith(`${directory}/`) ? path : null;
}

export function signCtoMappingConfirmationProof(
  pinnedRoot: PinnedProjectRoot,
  payload: UnsignedProof,
): CtoMappingConfirmationProof | null {
  const proof = { ...payload, proof_hmac: "" } as CtoMappingConfirmationProof;
  if (!proofShape(proof, true)
    || proof.root_identity.canonical_path !== pinnedRoot.canonical_root
    || proof.root_identity.dev !== pinnedRoot.dev
    || proof.root_identity.ino !== pinnedRoot.ino
    || proof.mapping_record_path !== canonicalRecordPath(proof)
    || proof.state_path !== canonicalStatePath(proof.confirmation_context.feature_id)) return null;
  const signature = proofHmac(pinnedRoot, payload);
  return signature ? { ...proof, proof_hmac: signature } : null;
}

export function verifyCtoMappingConfirmationProof(
  pinnedRoot: PinnedProjectRoot,
  proof: CtoMappingConfirmationProof,
  expected: CtoMappingConfirmationProofPayload,
): boolean {
  if (!proofShape(proof)
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
}

export function writeCtoMappingConfirmationProof(
  pinnedRoot: PinnedProjectRoot,
  proof: CtoMappingConfirmationProof,
): { ok: true; content: string; digest: string; path: string } | { ok: false; error: string } {
  if (!verifyCtoMappingConfirmationProof(pinnedRoot, proof, withoutHmac(proof))) return { ok: false, error: "mapping confirmation proof is malformed or authentication failed" };
  const relative = ctoMappingConfirmationProofRelativePath(proof.cto_run_id, proof.mapping_id, proof.proof_ref);
  if (!relative) return { ok: false, error: "mapping confirmation proof path is unsafe" };
  const content = `${JSON.stringify(proof, null, 2)}\r\n`;
  if (Buffer.byteLength(content, "utf8") > MAX_BYTES) return { ok: false, error: "mapping confirmation proof exceeds its byte cap" };
  try {
    pinnedRoot.ensureDirectories([join(PROOF_DIRECTORY, proof.cto_run_id, "artifacts", "mapping-confirmation-proofs", proof.mapping_id)]);
    if (pinnedRoot.pathEntryExists(relative)) {
      const existing = pinnedRoot.readFile(relative, { maxBytes: MAX_BYTES });
      const existingContent = Buffer.from(existing.bytes).toString("utf8");
      if (existingContent !== content) return { ok: false, error: "mapping confirmation proof already exists with different bytes" };
      return { ok: true, content, digest: createHash("sha256").update(content, "utf8").digest("hex"), path: relative };
    }
    pinnedRoot.writeExclusive(relative, Buffer.from(content, "utf8"));
    return { ok: true, content, digest: createHash("sha256").update(content, "utf8").digest("hex"), path: relative };
  } catch (error) {
    if (error instanceof PinnedRootError && error.code === "exists") {
      try {
        const existingContent = Buffer.from(pinnedRoot.readFile(relative, { maxBytes: MAX_BYTES }).bytes).toString("utf8");
        if (existingContent === content) return { ok: true, content, digest: createHash("sha256").update(content, "utf8").digest("hex"), path: relative };
      } catch { /* report the original conflict below */ }
    }
    return { ok: false, error: `mapping confirmation proof publication failed: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export function readCtoMappingConfirmationProof(
  pinnedRoot: PinnedProjectRoot,
  ctoRunId: string,
  mappingId: string,
  proofRef: string,
  expected: CtoMappingConfirmationProofPayload,
): CtoMappingConfirmationProofReadResult {
  const relative = ctoMappingConfirmationProofRelativePath(ctoRunId, mappingId, proofRef);
  if (!relative) return { ok: false, code: "invalid", error: "mapping confirmation proof selector is unsafe" };
  try {
    if (!pinnedRoot.pathEntryExists(relative)) return { ok: false, code: "absent", error: "mapping confirmation proof is absent" };
    const info = pinnedRoot.pathEntryInfo(relative);
    if (!info || info.kind !== "file") return { ok: false, code: "invalid", error: "mapping confirmation proof is not a regular file" };
    const content = Buffer.from(pinnedRoot.readFile(relative, { maxBytes: MAX_BYTES }).bytes).toString("utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(content) as unknown; } catch { return { ok: false, code: "invalid", error: "mapping confirmation proof is not valid JSON" }; }
    if (!proofShape(parsed)) return { ok: false, code: "invalid", error: "mapping confirmation proof schema is invalid" };
    if (!verifyCtoMappingConfirmationProof(pinnedRoot, parsed, expected)) return { ok: false, code: "invalid", error: "mapping confirmation proof does not match the canonical confirmation image or authentication failed" };
    if (parsed.cto_run_id !== ctoRunId || parsed.mapping_id !== mappingId || parsed.proof_ref !== proofRef) return { ok: false, code: "invalid", error: "mapping confirmation proof identity is foreign" };
    return { ok: true, proof: parsed, content };
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
      sha256: createHash("sha256").update(expectedContent, "utf8").digest("hex"),
    });
    return true;
  } catch (error) {
    return error instanceof PinnedRootError && error.code === "not_found";
  }
}
