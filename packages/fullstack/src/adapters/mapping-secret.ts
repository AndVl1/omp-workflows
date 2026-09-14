import { deriveRuntimeSecretKey, readOrCreateRootRuntimeSecret } from "@andvl1/omp-workflows-core/cto-runtime";
import type { PinnedProjectRoot } from "@andvl1/omp-workflows-core";

const TELEGRAM_MAPPING_SECRET_DOMAIN = "telegram-mapping-v1";

/** Root-scoped protected key shared by sender and bridge processes. */
export function readOrCreateProtectedTelegramMappingSecret(root: PinnedProjectRoot): string | null {
  const master = readOrCreateRootRuntimeSecret(root);
  return master ? deriveRuntimeSecretKey(master, TELEGRAM_MAPPING_SECRET_DOMAIN) : null;
}
