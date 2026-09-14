import {
  signCtoRuntimeProof,
  verifyCtoRuntimeProof,
  type CtoRuntimeProofAuthority,
} from "@andvl1/omp-workflows-core/cto-runtime";

export const TELEGRAM_MAPPING_PROOF_DOMAIN = "telegram-mapping-v1" as const;

/** Sign one canonical Telegram mapping payload without exposing root key bytes. */
export function signTelegramMappingProof(authority: CtoRuntimeProofAuthority, canonicalPayload: string): string | null {
  return signCtoRuntimeProof(authority, TELEGRAM_MAPPING_PROOF_DOMAIN, canonicalPayload);
}

/** Verify one canonical Telegram mapping payload against the live authority. */
export function verifyTelegramMappingProof(
  authority: CtoRuntimeProofAuthority,
  canonicalPayload: string,
  proof: string,
): boolean {
  return verifyCtoRuntimeProof(authority, TELEGRAM_MAPPING_PROOF_DOMAIN, canonicalPayload, proof);
}
