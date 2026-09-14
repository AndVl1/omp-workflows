import type { LanguageSelection, LanguageSelectionSource } from "./types.js";
import { isRecord, sha256Hex } from "./validation.js";

/** Maximum length of a normalized BCP-47-like language tag. */
export const MAX_LANGUAGE_TAG_LENGTH = 64;

/** Result codes returned when a language cannot be selected safely. */
export type LanguageResolutionCode = "LANGUAGE_INPUT_INVALID" | "LANGUAGE_MISSING" | "LANGUAGE_UNSUPPORTED";

/** Input layers for deterministic feature language resolution. */
export interface LanguageResolutionInput {
  /** Explicit language for this feature, when configured. */
  featureOverride?: unknown;
  /** Default language configured by the workflow owner/project. */
  projectDefault?: unknown;
  /** Language inferred from the request that initiated the workflow. */
  requestLanguage?: unknown;
}

/** A successful language resolution or a fail-closed diagnostic. */
export type LanguageResolution = LanguageSelection;

const FIELD_NAMES = ["featureOverride", "projectDefault", "requestLanguage"] as const;
type LanguageField = (typeof FIELD_NAMES)[number];

function asciiLower(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code >= 65 && code <= 90 ? String.fromCharCode(code + 32) : character;
  }
  return result;
}

function asciiUpper(value: string): string {
  let result = "";
  for (const character of value) {
    const code = character.charCodeAt(0);
    result += code >= 97 && code <= 122 ? String.fromCharCode(code - 32) : character;
  }
  return result;
}

function titlecaseAscii(value: string): string {
  return value.length === 0 ? value : asciiUpper(value[0] ?? "") + asciiLower(value.slice(1));
}

function allAsciiLetters(value: string): boolean {
  return /^[A-Za-z]+$/.test(value);
}

function allAsciiAlphaNumeric(value: string): boolean {
  return /^[A-Za-z0-9]+$/.test(value);
}

function isExtensionSingleton(value: string): boolean {
  return /^[0-9A-WY-Za-w-y-z]$/.test(value);
}

function isPrivateUseSingleton(value: string): boolean {
  return value === "x" || value === "X";
}

/**
 * Normalize a language tag without consulting the host locale database.
 *
 * Only the case conventions defined by BCP-47 are applied: language and
 * variants are lowercase, script is title-cased, and region is uppercase.
 * Alias replacement (for example, deprecated language identifiers) is
 * deliberately not performed because it would make the contract depend on
 * an ICU/locale database version.
 *
 * @returns the normalized tag, or `null` when the input is not supported.
 */
export function normalizeLanguage(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (
    trimmed.length === 0
    || trimmed.length > MAX_LANGUAGE_TAG_LENGTH
    || !/^[\x20-\x7E]+$/.test(trimmed)
    || trimmed.includes("_")
  ) return null;

  const parts = trimmed.split("-");
  const primary = parts[0];
  if (!primary || primary.length < 2 || primary.length > 8 || !allAsciiLetters(primary)) return null;

  const normalized: string[] = [asciiLower(primary)];
  let index = 1;
  if (index < parts.length && /^[A-Za-z]{4}$/.test(parts[index] ?? "")) {
    normalized.push(titlecaseAscii(parts[index] ?? ""));
    index += 1;
  }
  if (index < parts.length && /^([A-Za-z]{2}|[0-9]{3})$/.test(parts[index] ?? "")) {
    const region = parts[index] ?? "";
    normalized.push(allAsciiLetters(region) ? asciiUpper(region) : region);
    index += 1;
  }

  const extensionSingletons = new Set<string>();
  while (index < parts.length) {
    const part = parts[index] ?? "";
    if (part.length === 0) return null;

    if (isPrivateUseSingleton(part)) {
      if (extensionSingletons.has("x") || index + 1 >= parts.length) return null;
      extensionSingletons.add("x");
      normalized.push("x");
      index += 1;
      let privateSubtagCount = 0;
      while (index < parts.length) {
        const privatePart = parts[index] ?? "";
        if (privatePart.length < 1 || privatePart.length > 8 || !allAsciiAlphaNumeric(privatePart)) return null;
        normalized.push(asciiLower(privatePart));
        privateSubtagCount += 1;
        index += 1;
      }
      return privateSubtagCount > 0 ? normalized.join("-") : null;
    }

    if (isExtensionSingleton(part)) {
      const singleton = asciiLower(part);
      if (extensionSingletons.has(singleton)) return null;
      extensionSingletons.add(singleton);
      normalized.push(singleton);
      index += 1;
      let extensionSubtagCount = 0;
      while (index < parts.length) {
        const extensionPart = parts[index] ?? "";
        if (isExtensionSingleton(extensionPart) || isPrivateUseSingleton(extensionPart)) break;
        if (extensionPart.length < 2 || extensionPart.length > 8 || !allAsciiAlphaNumeric(extensionPart)) return null;
        normalized.push(asciiLower(extensionPart));
        extensionSubtagCount += 1;
        index += 1;
      }
      if (extensionSubtagCount === 0) return null;
      continue;
    }

    const variantIsFourDigits = /^\d{4}$/.test(part);
    if ((!variantIsFourDigits && (part.length < 5 || part.length > 8)) || !allAsciiAlphaNumeric(part)) return null;
    normalized.push(asciiLower(part));
    index += 1;
  }

  return normalized.join("-");
}

/** Return whether a value is a supported, normalizable language tag. */
export function isSupportedLanguage(value: unknown): value is string {
  return normalizeLanguage(value) !== null;
}

function selectionHash(language: string, source: LanguageSelectionSource): string {
  // Delimit fields explicitly so provenance cannot be changed without changing the digest.
  return sha256Hex(`language=${language}\nsource=${source}`);
}

/**
 * Resolve specification language using feature override, project default, then the
 * initiating request. Invalid configured values fail closed instead of being
 * silently replaced by a lower-precedence layer.
 *
 * The returned selection is frozen. Its digest binds both normalized language
 * and provenance source, allowing phase artifacts to detect a source change
 * even when the human-facing language remains the same.
 */
export function resolveSpecificationLanguage(input: LanguageResolutionInput): LanguageSelection {
  if (!isRecord(input)) throw new TypeError("language resolution input must be an object");
  for (const key of Object.keys(input)) {
    if (!(FIELD_NAMES as readonly string[]).includes(key)) throw new TypeError(`unknown language resolution field '${key}'`);
  }

  const layers: readonly [LanguageField, LanguageSelectionSource][] = [
    ["featureOverride", "feature_override"],
    ["projectDefault", "project_default"],
    ["requestLanguage", "request_language"],
  ];
  for (const [field, source] of layers) {
    const raw = input[field];
    if (raw === undefined || raw === null) continue;
    const language = normalizeLanguage(raw);
    if (language === null) throw new TypeError(`${field} must be a bounded BCP-47-like language tag`);
    return Object.freeze({
      language,
      source,
      selection_hash: selectionHash(language, source),
    });
  }

  throw new TypeError("requestLanguage is required when no featureOverride or projectDefault is configured");
}
