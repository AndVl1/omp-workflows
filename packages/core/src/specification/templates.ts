import { existsSync, readFileSync, readdirSync } from "node:fs";
import type { Dirent } from "node:fs";
import { join } from "node:path";
import { findProfileDir } from "../engine/profile.js";
import { extractSemanticMarkers, sha256Hex } from "./validation.js";


export const SPECIFICATION_TEMPLATE_SET_ID = "specification-default";
export const SHIPPED_SPECIFICATION_TEMPLATE_IDS = ["constitution", "specify", "plan", "tasks", "status"] as const;
export type ShippedSpecificationTemplateId = (typeof SHIPPED_SPECIFICATION_TEMPLATE_IDS)[number];

/**
 * `project_default` is the durable data-model name for the default supplied
 * by the registered workflow owner. It is not discovered from arbitrary
 * project paths by this resolver.
 */
export type SpecificationTemplateSource = "feature_override" | "project_default" | "shipped_default";

const SOURCE_RANK: Record<SpecificationTemplateSource, number> = {
  feature_override: 0,
  project_default: 1,
  shipped_default: 2,
};

export interface ResolvedSpecificationTemplate {
  template_id: string;
  source: SpecificationTemplateSource;
  content: string;
  content_hash: string;
  required_markers: string[];
}

export type SpecificationTemplateCode =
  | "SPEC_TEMPLATE_UNKNOWN"
  | "SPEC_TEMPLATE_UNRESOLVED"
  | "SPEC_TEMPLATE_INVALID_UTF8"
  | "SPEC_TEMPLATE_TOO_LARGE"
  | "SPEC_TEMPLATE_INTERPOLATION_UNSAFE"
  | "SPEC_TEMPLATE_MARKERS_MISSING"
  | "SPEC_TEMPLATE_MARKERS_DUPLICATE"
  | "SPEC_TEMPLATE_MARKERS_ALTERED"
  | "SPEC_TEMPLATE_SET_EMPTY"
  | "SPEC_TEMPLATE_SET_DUPLICATE";

type SpecificationTemplateFailure = { ok: false; code: SpecificationTemplateCode; error: string };

export type SpecificationTemplateResolution =
  | { ok: true; value: ResolvedSpecificationTemplate }
  | SpecificationTemplateFailure;

/**
 * Marker-validation result: the success payload is `markers` (never `value`),
 * so `ok` is a genuine discriminant and `!result.ok` narrows soundly to the
 * failure member.
 */
type SpecificationMarkerValidation =
  | { ok: true; markers: string[] }
  | SpecificationTemplateFailure;

export interface SpecificationTemplateSetSelection {
  template_set_id: string;
  source: SpecificationTemplateSource;
  content_hash: string;
  required_markers: string[];
}

export interface SpecificationTemplateSetResolution {
  templates: ResolvedSpecificationTemplate[];
  selection: SpecificationTemplateSetSelection;
}

const MAX_TEMPLATE_BYTES = 256 * 1024;
const TEMPLATE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const CANONICAL_MARKER_RE = /^<!-- omp-spec:marker:([a-z0-9_-]+) -->$/;
const SAFE_INTERPOLATION_RE = /^{{[A-Z][A-Z0-9_]{0,63}}}$/;

export function shippedSpecificationTemplateDir(): string {
  return join(findProfileDir(), "templates", "specification");
}

/**
 * Load only bounded, regular, valid UTF-8 files from the package-owned
 * template directory. Template ids are single safe path components; symlinks
 * and every other directory entry type are ignored, so a shipped lookup cannot
 * become an arbitrary local-file read.
 */
export function loadShippedSpecificationTemplates(): Record<string, string> {
  const dir = shippedSpecificationTemplateDir();
  const templates: Record<string, string> = Object.create(null) as Record<string, string>;
  if (!existsSync(dir)) return templates;

  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return templates;
  }

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const templateId = entry.name.slice(0, -3);
    if (!TEMPLATE_ID_RE.test(templateId)) continue;

    try {
      const bytes = readFileSync(join(dir, entry.name));
      if (bytes.length === 0 || bytes.length > MAX_TEMPLATE_BYTES) continue;
      const content = bytes.toString("utf8");
      if (!Buffer.from(content, "utf8").equals(bytes) || content.includes("\0")) continue;
      templates[templateId] = content;
    } catch {
      // Resolution below fails closed when a required shipped baseline cannot
      // be read; this loader never substitutes a less authoritative source.
    }
  }

  return templates;
}

function failure(code: SpecificationTemplateCode, error: string): SpecificationTemplateFailure {
  return { ok: false, code, error };
}

function isShippedTemplateId(templateId: string): templateId is ShippedSpecificationTemplateId {
  return (SHIPPED_SPECIFICATION_TEMPLATE_IDS as readonly string[]).includes(templateId);
}

function contentFailure(
  templateId: string,
  source: SpecificationTemplateSource,
  content: string,
): SpecificationTemplateResolution | null {
  const bytes = Buffer.from(content, "utf8");
  if (bytes.toString("utf8") !== content || content.includes("\0")) {
    return failure(
      "SPEC_TEMPLATE_INVALID_UTF8",
      `template '${templateId}' (${source}) must be valid NUL-free UTF-8`,
    );
  }
  if (bytes.length > MAX_TEMPLATE_BYTES) {
    return failure(
      "SPEC_TEMPLATE_TOO_LARGE",
      `template '${templateId}' (${source}) exceeds the ${MAX_TEMPLATE_BYTES}-byte UTF-8 limit`,
    );
  }

  // Interpolation remains inert data at this boundary. Only canonical,
  // identifier-only placeholders are admitted; path fragments, helpers,
  // expressions, partials, and unmatched delimiters fail before dispatch.
  let cursor = 0;
  while (cursor < content.length) {
    const open = content.indexOf("{{", cursor);
    const close = content.indexOf("}}", cursor);
    if (open === -1 && close === -1) break;
    if (open === -1 || close !== -1 && close < open) {
      return failure(
        "SPEC_TEMPLATE_INTERPOLATION_UNSAFE",
        `template '${templateId}' (${source}) contains an unmatched interpolation delimiter`,
      );
    }
    const end = content.indexOf("}}", open + 2);
    if (end === -1) {
      return failure(
        "SPEC_TEMPLATE_INTERPOLATION_UNSAFE",
        `template '${templateId}' (${source}) contains an unmatched interpolation delimiter`,
      );
    }
    const token = content.slice(open, end + 2);
    if (!SAFE_INTERPOLATION_RE.test(token) || token.slice(2, -2).includes("{{")) {
      return failure(
        "SPEC_TEMPLATE_INTERPOLATION_UNSAFE",
        `template '${templateId}' (${source}) contains a non-canonical interpolation token`,
      );
    }
    cursor = end + 2;
  }

  return null;
}

function validateMarkers(
  templateId: string,
  source: SpecificationTemplateSource,
  content: string,
  requiredMarkers?: readonly string[],
): SpecificationMarkerValidation {
  const counts = new Map<string, number>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.toLowerCase().includes("omp-spec:marker:")) continue;
    const match = CANONICAL_MARKER_RE.exec(trimmed);
    if (!match) {
      return failure(
        "SPEC_TEMPLATE_MARKERS_ALTERED",
        `template '${templateId}' (${source}) contains a non-canonical omp-spec:marker directive`,
      );
    }
    const marker = match[1]!;
    counts.set(marker, (counts.get(marker) ?? 0) + 1);
  }

  const duplicateMarkers = [...counts]
    .filter(([, count]) => count > 1)
    .map(([marker]) => marker)
    .sort((left, right) => left.localeCompare(right));
  if (duplicateMarkers.length > 0) {
    return failure(
      "SPEC_TEMPLATE_MARKERS_DUPLICATE",
      `template '${templateId}' (${source}) duplicates required semantic marker(s): ${duplicateMarkers.join(", ")}`,
    );
  }

  const markers = extractSemanticMarkers(content);
  if (markers.length === 0) {
    return failure(
      "SPEC_TEMPLATE_MARKERS_MISSING",
      `template '${templateId}' (${source}) carries no stable omp-spec:marker directives; dispatching without mandatory markers is not permitted`,
    );
  }

  // The selected layer is authoritative: it must carry the exact shipped
  // required marker set for this template. Missing markers would dispatch an
  // incomplete document, and extra markers would extend the mandatory section
  // contract, so either deviation fails closed instead of falling through.
  if (requiredMarkers) {
    const present = new Set(markers);
    const missingMarkers = requiredMarkers
      .filter((marker) => !present.has(marker))
      .sort((left, right) => left.localeCompare(right));
    if (missingMarkers.length > 0) {
      return failure(
        "SPEC_TEMPLATE_MARKERS_MISSING",
        `template '${templateId}' (${source}) is missing required semantic marker(s): ${missingMarkers.join(", ")}`,
      );
    }
    const requiredSet = new Set(requiredMarkers);
    const unexpectedMarkers = markers
      .filter((marker) => !requiredSet.has(marker))
      .sort((left, right) => left.localeCompare(right));
    if (unexpectedMarkers.length > 0) {
      return failure(
        "SPEC_TEMPLATE_MARKERS_ALTERED",
        `template '${templateId}' (${source}) carries semantic marker(s) outside the shipped required set: ${unexpectedMarkers.join(", ")}`,
      );
    }
  }

  return { ok: true, markers };
}

function resolveSpecificationTemplateFromShipped(
  input: {
    template_id: string;
    feature_override_content?: string | null;
    project_default_content?: string | null;
  },
  shippedTemplates: Readonly<Record<string, string>>,
): SpecificationTemplateResolution {
  if (typeof input.template_id !== "string"
    || !TEMPLATE_ID_RE.test(input.template_id)
    || !isShippedTemplateId(input.template_id)) {
    return failure(
      "SPEC_TEMPLATE_UNKNOWN",
      `unknown template id ${JSON.stringify(input.template_id)}`,
    );
  }

  const shippedContent = shippedTemplates[input.template_id];
  if (typeof shippedContent !== "string") {
    return failure(
      "SPEC_TEMPLATE_UNRESOLVED",
      `shipped baseline does not resolve template '${input.template_id}'`,
    );
  }

  const shippedContentFailure = contentFailure(input.template_id, "shipped_default", shippedContent);
  if (shippedContentFailure) return shippedContentFailure;
  const shippedMarkers = validateMarkers(input.template_id, "shipped_default", shippedContent);
  if (!shippedMarkers.ok) return shippedMarkers;

  const layers: Array<[SpecificationTemplateSource, string | null | undefined]> = [
    ["feature_override", input.feature_override_content],
    ["project_default", input.project_default_content],
    ["shipped_default", shippedContent],
  ];

  for (const [source, content] of layers) {
    if (content === null || content === undefined) continue;
    if (typeof content !== "string") {
      return failure(
        "SPEC_TEMPLATE_UNRESOLVED",
        `template '${input.template_id}' (${source}) must be supplied as local UTF-8 text`,
      );
    }

    const invalidContent = contentFailure(input.template_id, source, content);
    if (invalidContent) return invalidContent;
    const markerValidation = validateMarkers(input.template_id, source, content, shippedMarkers.markers);
    if (!markerValidation.ok) return markerValidation;

    return {
      ok: true,
      value: {
        template_id: input.template_id,
        source,
        content,
        content_hash: sha256Hex(content),
        required_markers: [...markerValidation.markers],
      },
    };
  }

  return failure(
    "SPEC_TEMPLATE_UNRESOLVED",
    `no feature override, project default, or shipped baseline resolves template '${input.template_id}'`,
  );
}

/**
 * Resolve one known template by strict precedence. A present higher-precedence
 * template is authoritative: invalid content fails closed instead of falling
 * through to a lower-precedence template.
 */
export function resolveSpecificationTemplate(input: {
  template_id: string;
  feature_override_content?: string | null;
  project_default_content?: string | null;
}): SpecificationTemplateResolution {
  return resolveSpecificationTemplateFromShipped(input, loadShippedSpecificationTemplates());
}

export function resolveSpecificationTemplateSet(input: {
  template_ids: readonly string[];
  feature_overrides?: Record<string, string>;
  project_defaults?: Record<string, string>;
}):
  | { ok: true; value: SpecificationTemplateSetResolution }
  | { ok: false; code: SpecificationTemplateCode; error: string } {
  if (input.template_ids.length === 0) {
    return {
      ok: false,
      code: "SPEC_TEMPLATE_SET_EMPTY",
      error: "a specification template set must contain at least one template id",
    };
  }

  const seen = new Set<string>();
  for (const templateId of input.template_ids) {
    if (seen.has(templateId)) {
      return {
        ok: false,
        code: "SPEC_TEMPLATE_SET_DUPLICATE",
        error: `specification template set contains duplicate template id '${templateId}'`,
      };
    }
    seen.add(templateId);
  }

  const shippedTemplates = loadShippedSpecificationTemplates();
  const templates: ResolvedSpecificationTemplate[] = [];
  for (const templateId of input.template_ids) {
    const resolved = resolveSpecificationTemplateFromShipped(
      {
        template_id: templateId,
        feature_override_content: input.feature_overrides?.[templateId] ?? null,
        project_default_content: input.project_defaults?.[templateId] ?? null,
      },
      shippedTemplates,
    );
    if (!resolved.ok) return resolved;
    templates.push(resolved.value);
  }

  const setSource = templates
    .map((template) => template.source)
    .reduce(
      (best, candidate) => SOURCE_RANK[candidate] < SOURCE_RANK[best] ? candidate : best,
      "shipped_default" as SpecificationTemplateSource,
    );
  const contentHashes = templates
    .map((template) => [template.template_id, template.source, template.content_hash] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  const markers: string[] = [];
  for (const template of templates) {
    for (const marker of template.required_markers) {
      if (!markers.includes(marker)) markers.push(marker);
    }
  }

  return {
    ok: true,
    value: {
      templates,
      selection: {
        template_set_id: SPECIFICATION_TEMPLATE_SET_ID,
        source: setSource,
        content_hash: sha256Hex(JSON.stringify(contentHashes)),
        required_markers: markers,
      },
    },
  };
}
