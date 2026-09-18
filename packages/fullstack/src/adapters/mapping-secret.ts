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

export const TELEGRAM_DELIVERY_EFFECT_PROOF_DOMAIN = "telegram-delivery-effect-v1" as const;

/** Sign one canonical Telegram delivery-effect payload without exposing root key bytes. */
export function signTelegramDeliveryEffectProof(authority: CtoRuntimeProofAuthority, canonicalPayload: string): string | null {
  return signCtoRuntimeProof(authority, TELEGRAM_DELIVERY_EFFECT_PROOF_DOMAIN, canonicalPayload);
}

/** Verify one canonical Telegram delivery-effect payload against the live authority. */
export function verifyTelegramDeliveryEffectProof(
  authority: CtoRuntimeProofAuthority,
  canonicalPayload: string,
  proof: string,
): boolean {
  return verifyCtoRuntimeProof(authority, TELEGRAM_DELIVERY_EFFECT_PROOF_DOMAIN, canonicalPayload, proof);
}
