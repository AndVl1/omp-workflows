import { TextDecoder } from "node:util";
import { evaluateConstitutionUsability } from "../gates/constitution.js";
import { resolveConstitutionProvider } from "./constitution-provider.js";
import type { ConstitutionBinding } from "./types.js";
import { PinnedProjectRoot } from "./pinned-root.js";
import { MAX_PHASE_INPUT_BYTES } from "./limits.js";
import { isRecord, isSafeRelativePath, sha256Hex } from "./validation.js";

export interface ConstitutionPrincipleIdentity {
  principle_id: string;
  ordinal: number;
  title: string;
  optional: boolean;
}

/** Pure, locale-neutral derivation of the applicable principle identity set. */
export function parseConstitutionPrincipleIdentities(content: string): ConstitutionPrincipleIdentity[] {
  const identities: ConstitutionPrincipleIdentity[] = [];
  let optionalMarker = false;
  for (const line of content.normalize("NFC").split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "<!-- omp-spec:principle:optional -->") { optionalMarker = true; continue; }
    const heading = /^##[ \t]+([^#\r\n].*?)[ \t]*$/u.exec(line);
    if (!heading) { if (trimmed.length > 0) optionalMarker = false; continue; }
    const title = heading[1]!.normalize("NFC").replace(/[\s\u00a0]+/gu, " ").trim();
    if (title.length === 0) { optionalMarker = false; continue; }
    const ordinal = identities.length + 1;
    identities.push({ ordinal, title, optional: optionalMarker, principle_id: `constitution:${ordinal}:${sha256Hex(title).slice(0, 12)}` });
    optionalMarker = false;
  }
  return identities;
}


export type PinnedConstitutionFreshness =
  | { ok: true; value: { binding: ConstitutionBinding; content: string; identities: ConstitutionPrincipleIdentity[] } }
  | { ok: false; error: string };

/**
 * Resolve the currently selected constitution through one pinned root. This
 * helper deliberately has no prerequisite/phase imports, so phase dispatch
 * can reassert the source under its durable transaction without a module
 * cycle. A missing, malformed, non-usable, or unresolved gate always blocks
 * the transition; workspace bindings are not live authority by themselves.
 */
export function readPinnedCurrentConstitution(
  projectRoot: string,
  pinnedRoot: PinnedProjectRoot,
  expected: ConstitutionBinding,
  options: { requireGate?: boolean } = {},
): PinnedConstitutionFreshness {
  if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before constitution freshness check" };
  if (!isSafeRelativePath(expected.path)) return { ok: false, error: "constitution binding path is not a safe project-relative path" };
  try {
    const selection = resolveConstitutionProvider(projectRoot, {
      pinnedRoot,
      ...(expected.provider_id === "explicit" ? { explicit_path: expected.path } : {}),
    });
    if (!selection.ok) return { ok: false, error: selection.error };
    if (selection.value.provider_id !== expected.provider_id || selection.value.path !== expected.path) {
      return { ok: false, error: "current constitution provider selection does not match the workspace binding" };
    }
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      pinnedRoot.readFile(expected.path, { maxBytes: MAX_PHASE_INPUT_BYTES }).bytes,
    );
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed while reading the current constitution" };
    const usability = evaluateConstitutionUsability(content);
    if (usability.status !== "usable") return { ok: false, error: "current constitution is not usable: " + usability.detail };
    const contentSha = sha256Hex(content);
    if (contentSha !== expected.content_sha256) return { ok: false, error: "current constitution bytes do not match the workspace binding" };
    const versionMatch = /(^|\n)Version:\s*([^\s]+)/iu.exec(content);
    const version = versionMatch?.[2] ?? "0.0.0";
    const semanticHash = sha256Hex(content.replace(/\r\n?/gu, "\n").replace(/\s+/gu, " ").trim());
    if (version !== expected.version || semanticHash !== expected.semantic_hash) {
      return { ok: false, error: "current constitution binding metadata does not match the workspace" };
    }
    const identities = parseConstitutionPrincipleIdentities(content);
    if (identities.length === 0) return { ok: false, error: "current constitution has no usable principle identities" };
    if (options.requireGate === false) {
      if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before constitution source guard completed" };
      return { ok: true, value: { binding: expected, content, identities } };
    }
    const gatePath = ".work-state/specification/constitution/gate.json";
    if (!pinnedRoot.pathEntryExists(gatePath)) return { ok: false, error: "constitution gate is missing" };
    {
      const gateRaw = new TextDecoder("utf-8", { fatal: true }).decode(pinnedRoot.readFile(gatePath, { maxBytes: 512 * 1024 }).bytes);
      const parsed: unknown = JSON.parse(gateRaw);
      if (!isRecord(parsed) || !isRecord(parsed.gate)) return { ok: false, error: "constitution gate is malformed" };
      const gate = parsed.gate;
      if ((gate.status !== "usable" && gate.status !== "approved") || gate.usability_result !== "usable" || gate.checkpoint_ref !== null || !isRecord(gate.binding) || !isRecord(gate.provider)) {
        return { ok: false, error: "constitution gate is unresolved for phase dispatch" };
      }
      const gateProvider = gate.provider as Record<string, unknown>;
      if (gateProvider.provider_id !== selection.value.provider_id || gateProvider.path !== selection.value.path) {
        return { ok: false, error: "constitution gate provider does not match the current selection" };
      }
      const gateBinding = gate.binding as Record<string, unknown>;
      if (gateBinding.provider_id !== expected.provider_id || gateBinding.path !== expected.path
        || gateBinding.version !== expected.version || gateBinding.content_sha256 !== expected.content_sha256
        || gateBinding.semantic_hash !== expected.semantic_hash || gateBinding.validation_ref !== expected.validation_ref) {
        return { ok: false, error: "constitution gate binding does not match the workspace binding" };
      }
    }
    const impactDir = ".work-state/specification/constitution";
    if (pinnedRoot.pathEntryExists(impactDir)) {
      for (const entry of pinnedRoot.listDirectory(impactDir, { maxEntries: 256, maxNameBytes: 8192 })) {
        if (/^constitution-impact-transaction-[a-f0-9]{64}\.json$/u.test(entry)) {
          return { ok: false, error: "constitution impact assessment is unresolved" };
        }
      }
    }
    if (!pinnedRoot.isStable()) return { ok: false, error: "project root changed before constitution dispatch authorization" };
    return { ok: true, value: { binding: expected, content, identities } };
  } catch (error) {
    return { ok: false, error: "current constitution is unreadable: " + (error instanceof Error ? error.message : String(error)) };
  }
}

export function readPinnedConstitutionPrincipleIdentities(
  pinnedRoot: PinnedProjectRoot,
  binding: ConstitutionBinding,
): { ok: true; value: ConstitutionPrincipleIdentity[] } | { ok: false; error: string } {
  if (!isSafeRelativePath(binding.path)) return { ok: false, error: "constitution binding path is not a safe project-relative path" };
  try {
    const content = new TextDecoder("utf-8", { fatal: true }).decode(
      pinnedRoot.readFile(binding.path, { maxBytes: MAX_PHASE_INPUT_BYTES }).bytes,
    );
    if (!pinnedRoot.isStable()) return { ok: false, error: "pinned project root changed while reading the approved constitution" };
    if (sha256Hex(content) !== binding.content_sha256) return { ok: false, error: "approved constitution bytes do not match the bound content hash" };
    return { ok: true, value: parseConstitutionPrincipleIdentities(content) };
  } catch (error) {
    return { ok: false, error: `approved constitution artifact is unreadable: ${error instanceof Error ? error.message : String(error)}` };
  }
}
