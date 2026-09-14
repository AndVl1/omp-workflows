import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  SHIPPED_SPECIFICATION_TEMPLATE_IDS,
  type ShippedSpecificationTemplateId,
} from "./templates.js";
import { PinnedProjectRoot } from "./pinned-root.js";
import { isRecord, isSafeFeatureId } from "./validation.js";

const CONFIG_RELATIVE_PATH = ".omp/specification.json";
const MAX_CONFIG_BYTES = 128 * 1024;
const MAX_TEMPLATE_BYTES = 256 * 1024;
const CONFIG_FIELDS: Readonly<Record<string, true>> = { language: true, templates: true, features: true };
const FEATURE_FIELDS: Readonly<Record<string, true>> = { language: true, templates: true };
const TEMPLATE_IDS: Readonly<Record<ShippedSpecificationTemplateId, true>> = {
  constitution: true,
  specify: true,
  plan: true,
  tasks: true,
  status: true,
};

export type SpecificationPresentationConfigCode =
  | "SPEC_CONFIG_INVALID"
  | "SPEC_CONFIG_INVALID_UTF8"
  | "SPEC_CONFIG_TOO_LARGE"
  | "SPEC_CONFIG_UNREADABLE"
  | "SPEC_CONFIG_PATH_UNAUTHORIZED"
  | "SPEC_TEMPLATE_PATH_UNAUTHORIZED"
  | "SPEC_TEMPLATE_UNREADABLE"
  | "SPEC_TEMPLATE_INVALID_UTF8"
  | "SPEC_TEMPLATE_TOO_LARGE";

export interface SpecificationPresentationConfig {
  feature_language?: unknown;
  project_language?: unknown;
  feature_templates: Partial<Record<ShippedSpecificationTemplateId, string>>;
  project_templates: Partial<Record<ShippedSpecificationTemplateId, string>>;
}

type ConfigFailure = {
  ok: false;
  code: SpecificationPresentationConfigCode;
  error: string;
};

export type SpecificationPresentationConfigResult =
  | { ok: true; value: SpecificationPresentationConfig }
  | ConfigFailure;

function failure(code: SpecificationPresentationConfigCode, error: string): ConfigFailure {
  return { ok: false, code, error };
}

function nodeErrorCode(error: unknown): string | null {
  return isRecord(error) && typeof error.code === "string" ? error.code : null;
}

function decodeUtf8(bytes: Buffer): string | null {
  const content = bytes.toString("utf8");
  return Buffer.from(content, "utf8").equals(bytes) && !content.includes("\0")
    ? content
    : null;
}
function boundedProjectFile(
  root: string,
  relativePath: string,
  maximumBytes: number,
  kind: "config" | "template",
  pinnedRoot?: PinnedProjectRoot,
): { ok: true; content: string } | ConfigFailure {
  const unauthorizedCode = kind === "config"
    ? "SPEC_CONFIG_PATH_UNAUTHORIZED"
    : "SPEC_TEMPLATE_PATH_UNAUTHORIZED";
  const unreadableCode = kind === "config"
    ? "SPEC_CONFIG_UNREADABLE"
    : "SPEC_TEMPLATE_UNREADABLE";
  const oversizedCode = kind === "config"
    ? "SPEC_CONFIG_TOO_LARGE"
    : "SPEC_TEMPLATE_TOO_LARGE";
  const invalidUtf8Code = kind === "config"
    ? "SPEC_CONFIG_INVALID_UTF8"
    : "SPEC_TEMPLATE_INVALID_UTF8";

  if (
    typeof relativePath !== "string"
    || relativePath.length === 0
    || relativePath.includes("\0")
    || relativePath.includes("\\")
    || isAbsolute(relativePath)
  ) {
    return failure(unauthorizedCode, `${kind} path must be a non-blank project-relative POSIX path`);
  }

  const candidate = resolve(root, relativePath);
  const relativeCandidate = relative(root, candidate);
  if (
    relativeCandidate.length === 0
    || relativeCandidate === ".."
    || relativeCandidate.startsWith(`..${sep}`)
    || isAbsolute(relativeCandidate)
  ) {
    return failure(unauthorizedCode, `${kind} path '${relativePath}' escapes the authorized project root`);
  }

  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) return failure(unauthorizedCode, `${kind} path '${relativePath}' cannot be read after the project root changed`);
    try {
      const entry = pinnedRoot.pathEntryInfo(relativeCandidate);
      if (!entry || entry.kind === "symlink") return failure(unauthorizedCode, `${kind} path '${relativePath}' contains a symbolic link or is absent`);
      if (entry.kind !== "file") return failure(unreadableCode, `${kind} path '${relativePath}' is not a regular file`);
      if (entry.size > maximumBytes) return failure(oversizedCode, `${kind} path '${relativePath}' exceeds the ${maximumBytes}-byte limit`);
      const bytes = Buffer.from(pinnedRoot.readFile(relativeCandidate, { maxBytes: maximumBytes }).bytes);
      if (!pinnedRoot.isStable()) return failure(unauthorizedCode, `${kind} path '${relativePath}' changed while it was read`);
      const content = decodeUtf8(bytes);
      if (content === null) return failure(invalidUtf8Code, `${kind} path '${relativePath}' must contain valid NUL-free UTF-8`);
      return { ok: true, content };
    } catch (error) {
      return failure(
        unreadableCode,
        `${kind} path '${relativePath}' cannot be read safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  let probe = root;
  const components = relativeCandidate.split(sep);
  try {
    for (let index = 0; index < components.length; index += 1) {
      probe = join(probe, components[index]!);
      const entry = lstatSync(probe);
      if (entry.isSymbolicLink()) {
        return failure(unauthorizedCode, `${kind} path '${relativePath}' contains a symbolic link`);
      }
      if (index < components.length - 1 && !entry.isDirectory()) {
        return failure(unreadableCode, `${kind} path '${relativePath}' has a non-directory parent component`);
      }
      if (index === components.length - 1 && !entry.isFile()) {
        return failure(unreadableCode, `${kind} path '${relativePath}' is not a regular file`);
      }
    }

    const realCandidate = realpathSync(candidate);
    if (realCandidate !== root && !realCandidate.startsWith(root + sep)) {
      return failure(unauthorizedCode, `${kind} path '${relativePath}' escapes the authorized project root`);
    }
    const size = statSync(realCandidate).size;
    if (size > maximumBytes) {
      return failure(oversizedCode, `${kind} path '${relativePath}' exceeds the ${maximumBytes}-byte limit`);
    }
    const bytes = readFileSync(realCandidate);
    const content = decodeUtf8(bytes);
    if (content === null) {
      return failure(invalidUtf8Code, `${kind} path '${relativePath}' must contain valid NUL-free UTF-8`);
    }
    return { ok: true, content };
  } catch (error) {
    return failure(
      unreadableCode,
      `${kind} path '${relativePath}' cannot be read safely: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateTemplatePaths(
  value: unknown,
  path: string,
): { ok: true; value: Partial<Record<ShippedSpecificationTemplateId, string>> } | ConfigFailure {
  if (value === undefined) return { ok: true, value: {} };
  if (!isRecord(value)) {
    return failure("SPEC_CONFIG_INVALID", `${path} must be an object keyed by shipped template id`);
  }
  const paths: Partial<Record<ShippedSpecificationTemplateId, string>> = {};
  for (const [templateId, templatePath] of Object.entries(value)) {
    if (TEMPLATE_IDS[templateId as ShippedSpecificationTemplateId] !== true) {
      return failure("SPEC_CONFIG_INVALID", `${path} contains unknown template id '${templateId}'`);
    }
    if (typeof templatePath !== "string" || templatePath.trim().length === 0) {
      return failure("SPEC_CONFIG_INVALID", `${path}.${templateId} must be a non-blank project-relative path`);
    }
    paths[templateId as ShippedSpecificationTemplateId] = templatePath;
  }
  return { ok: true, value: paths };
}

function unknownFields(value: Record<string, unknown>, allowed: Readonly<Record<string, true>>): string[] {
  return Object.keys(value).filter((field) => allowed[field] !== true).sort((left, right) => left.localeCompare(right));
}

function readConfiguredTemplates(
  root: string,
  paths: Partial<Record<ShippedSpecificationTemplateId, string>>,
  pinnedRoot?: PinnedProjectRoot,
): { ok: true; value: Partial<Record<ShippedSpecificationTemplateId, string>> } | ConfigFailure {
  const contents: Partial<Record<ShippedSpecificationTemplateId, string>> = {};
  for (const templateId of SHIPPED_SPECIFICATION_TEMPLATE_IDS) {
    const path = paths[templateId];
    if (path === undefined) continue;
    const loaded = boundedProjectFile(root, path, MAX_TEMPLATE_BYTES, "template", pinnedRoot);
    if (!loaded.ok) return loaded;
    contents[templateId] = loaded.content;
  }
  return { ok: true, value: contents };
}

/**
 * Read the one canonical workflow-owner configuration and its selected
 * project-relative template files. All returned template values are inert,
 * bounded UTF-8 strings ready for the existing template resolver.
 */
export function loadSpecificationPresentationConfig(
  projectRoot: string,
  featureId: string,
  pinnedRoot?: PinnedProjectRoot,
): SpecificationPresentationConfigResult {
  let root: string;
  if (pinnedRoot) {
    if (!pinnedRoot.isStable()) {
      return failure("SPEC_CONFIG_PATH_UNAUTHORIZED", "project root changed before configuration authorization");
    }
    root = pinnedRoot.canonical_root;
  } else {
    try {
      root = realpathSync(resolve(projectRoot));
      if (!statSync(root).isDirectory()) throw new Error("project root is not a directory");
    } catch (error) {
      return failure(
        "SPEC_CONFIG_PATH_UNAUTHORIZED",
        `project root cannot be authorized: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  if (!isSafeFeatureId(featureId)) {
    return failure("SPEC_CONFIG_INVALID", `unsafe feature id ${JSON.stringify(featureId)}`);
  }

  const ompDirectory = join(root, ".omp");
  if (pinnedRoot) {
    try {
      const entry = pinnedRoot.pathEntryInfo(".omp");
      if (!entry) return { ok: true, value: { feature_templates: {}, project_templates: {} } };
      if (entry.kind === "symlink") {
        return failure("SPEC_CONFIG_PATH_UNAUTHORIZED", ".omp must not be a symbolic link");
      }
      if (entry.kind !== "directory") {
        return failure("SPEC_CONFIG_UNREADABLE", ".omp must be a directory when specification.json is configured");
      }
      if (!pinnedRoot.pathEntryExists(CONFIG_RELATIVE_PATH)) {
        return { ok: true, value: { feature_templates: {}, project_templates: {} } };
      }
    } catch (error) {
      return failure(
        "SPEC_CONFIG_UNREADABLE",
        `.omp cannot be inspected safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  } else {
    try {
      const entry = lstatSync(ompDirectory);
      if (entry.isSymbolicLink()) {
        return failure("SPEC_CONFIG_PATH_UNAUTHORIZED", ".omp must not be a symbolic link");
      }
      if (!entry.isDirectory()) {
        return failure("SPEC_CONFIG_UNREADABLE", ".omp must be a directory when specification.json is configured");
      }
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        return { ok: true, value: { feature_templates: {}, project_templates: {} } };
      }
      return failure(
        "SPEC_CONFIG_UNREADABLE",
        `.omp cannot be inspected safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const configPath = join(root, CONFIG_RELATIVE_PATH);
    try {
      lstatSync(configPath);
    } catch (error) {
      if (nodeErrorCode(error) === "ENOENT") {
        return { ok: true, value: { feature_templates: {}, project_templates: {} } };
      }
      return failure(
        "SPEC_CONFIG_UNREADABLE",
        `${CONFIG_RELATIVE_PATH} cannot be inspected safely: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const loaded = boundedProjectFile(root, CONFIG_RELATIVE_PATH, MAX_CONFIG_BYTES, "config", pinnedRoot);
  if (!loaded.ok) return loaded;
  let parsed: unknown;
  try {
    parsed = JSON.parse(loaded.content) as unknown;
  } catch (error) {
    return failure(
      "SPEC_CONFIG_INVALID",
      `${CONFIG_RELATIVE_PATH} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(parsed)) {
    return failure("SPEC_CONFIG_INVALID", `${CONFIG_RELATIVE_PATH} must contain a JSON object`);
  }
  const topUnknown = unknownFields(parsed, CONFIG_FIELDS);
  if (topUnknown.length > 0) {
    return failure("SPEC_CONFIG_INVALID", `${CONFIG_RELATIVE_PATH} contains unknown field(s): ${topUnknown.join(", ")}`);
  }

  const projectPaths = validateTemplatePaths(parsed.templates, "$.templates");
  if (!projectPaths.ok) return projectPaths;

  let featureRecord: Record<string, unknown> | undefined;
  if (parsed.features !== undefined) {
    if (!isRecord(parsed.features)) {
      return failure("SPEC_CONFIG_INVALID", "$.features must be an object keyed by feature id");
    }
    if (Object.keys(parsed.features).length > 256) {
      return failure("SPEC_CONFIG_INVALID", "$.features exceeds the 256-feature configuration limit");
    }
    for (const [configuredFeatureId, configuredFeature] of Object.entries(parsed.features)) {
      if (!isSafeFeatureId(configuredFeatureId) || !isRecord(configuredFeature)) {
        return failure("SPEC_CONFIG_INVALID", `$.features.${configuredFeatureId} must be a safe feature id mapped to an object`);
      }
      const featureUnknown = unknownFields(configuredFeature, FEATURE_FIELDS);
      if (featureUnknown.length > 0) {
        return failure(
          "SPEC_CONFIG_INVALID",
          `$.features.${configuredFeatureId} contains unknown field(s): ${featureUnknown.join(", ")}`,
        );
      }
      if (configuredFeatureId === featureId) featureRecord = configuredFeature;
    }
  }

  const featurePaths = validateTemplatePaths(featureRecord?.templates, `$.features.${featureId}.templates`);
  if (!featurePaths.ok) return featurePaths;
  const projectTemplates = readConfiguredTemplates(root, projectPaths.value, pinnedRoot);
  if (!projectTemplates.ok) return projectTemplates;
  const featureTemplates = readConfiguredTemplates(root, featurePaths.value, pinnedRoot);
  if (!featureTemplates.ok) return featureTemplates;

  if (pinnedRoot && !pinnedRoot.isStable()) {
    return failure("SPEC_CONFIG_PATH_UNAUTHORIZED", "project root changed while presentation configuration was read");
  }
  return {
    ok: true,
    value: {
      feature_language: featureRecord?.language,
      project_language: parsed.language,
      feature_templates: featureTemplates.value,
      project_templates: projectTemplates.value,
    },
  };
}
