/**
 * Per-project model overrides: schema + validation.
 *
 * `.omp/models.json` lives at the project root next to `.omp/team.config.json`.
 * It declares the project's available models and a per-role override map:
 * which model (and hence which generated agent .md file under `.omp/agents/`)
 * the orchestrator should dispatch to for that role in this project.
 *
 * CORE_OVERRIDABLE_ROLES is intentionally hardcoded in this file rather than
 * a project-level config: security/audit-sensitive roles (security-tester,
 * manual-qa, devops) are excluded by design. See
 * `.work-state/artifacts/clarifications.json` for the rationale.
 */

/**
 * Roles that may be overridden. Hardcoded.
 */
export const CORE_OVERRIDABLE_ROLES = [
	"architect",
	"analyst",
	"code-reviewer",
	"developer",
	"qa",
] as const;

export type CoreOverridableRole = (typeof CORE_OVERRIDABLE_ROLES)[number];

/**
 * Known keys on ModelEntry and OverrideEntry. Anything else is rejected
 * to surface typos like `modelId` vs `model_id` instead of silently dropping
 * the field.
 */
const MODEL_ENTRY_KEYS = new Set(["id", "label", "provider", "model_id", "thinking"]);
const OVERRIDE_ENTRY_KEYS = new Set(["model_id", "agent_slug"]);

/**
 * Slug pattern for `agent_slug` and `id`: letters, digits, underscore, hyphen.
 * Rejects path separators and shell-unsafe characters so a malicious or
 * accidental slug cannot write outside `.omp/agents/`.
 */
const SAFE_SLUG = /^[a-z0-9_-]+$/i;

export interface ModelEntry {
	id: string;
	label: string;
	provider: string;
	model_id: string;
	/** Optional thinking level. e.g. "auto" | "high" | "off". */
	thinking?: string;
}

export interface OverrideEntry {
	model_id: string;
	agent_slug: string;
}

export interface ModelsJson {
	schema_version: 1;
	models: ModelEntry[];
	overrides: Record<string, OverrideEntry>;
}

export class ModelsJsonError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ModelsJsonError";
	}
}

/**
 * Parse and validate a ModelsJson from a parsed JSON value.
 *
 * - Throws ModelsJsonError on JSON parse error, schema_version mismatch,
 *   missing required field, unknown field, or wrong type. Hard errors.
 * - Unknown role keys in `overrides` are filtered out with a WARN
 *   callback (default: console.warn). The returned ModelsJson contains
 *   only entries for CORE_OVERRIDABLE_ROLES.
 *
 * The WARN callback is the only side effect; pass `{ warn: () => {} }`
 * from tests to silence it.
 */
export function validateModelsJson(
	raw: unknown,
	opts: { warn?: (message: string) => void } = {},
): ModelsJson {
	const warn = opts.warn ?? ((m) => console.warn(m));

	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ModelsJsonError("models.json: top-level must be an object");
	}
	const obj = raw as Record<string, unknown>;

	if (obj.schema_version !== 1) {
		throw new ModelsJsonError(
			`models.json: schema_version must be 1, got ${JSON.stringify(obj.schema_version)}`,
		);
	}

	if (!Array.isArray(obj.models)) {
		throw new ModelsJsonError("models.json: 'models' must be an array");
	}
	const models: ModelEntry[] = obj.models.map((m, i) => parseModelEntry(m, i));

	if (obj.overrides === null || typeof obj.overrides !== "object" || Array.isArray(obj.overrides)) {
		throw new ModelsJsonError("models.json: 'overrides' must be an object");
	}
	const overridesRaw = obj.overrides as Record<string, unknown>;
	const allowed = new Set<string>(CORE_OVERRIDABLE_ROLES);
	const overrides: Record<string, OverrideEntry> = {};

	for (const [role, value] of Object.entries(overridesRaw)) {
		if (!allowed.has(role)) {
			warn(`models.json: ignoring override for non-overridable role '${role}' (allowed: ${CORE_OVERRIDABLE_ROLES.join(", ")})`);
			continue;
		}
		overrides[role] = parseOverrideEntry(value, role);
	}

	return { schema_version: 1, models, overrides };
}

function parseModelEntry(raw: unknown, index: number): ModelEntry {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ModelsJsonError(`models.json: models[${index}] must be an object`);
	}
	const m = raw as Record<string, unknown>;
	rejectUnknownKeys(m, MODEL_ENTRY_KEYS, `models[${index}]`);

	const id = requireSlug(m.id, `models[${index}].id`);
	const label = requireString(m.label, `models[${index}].label`);
	const provider = requireString(m.provider, `models[${index}].provider`);
	const model_id = requireString(m.model_id, `models[${index}].model_id`);

	const entry: ModelEntry = { id, label, provider, model_id };
	if (m.thinking !== undefined) {
		if (typeof m.thinking !== "string") {
			throw new ModelsJsonError(`models[${index}].thinking must be a string`);
		}
		entry.thinking = m.thinking;
	}
	return entry;
}

function parseOverrideEntry(raw: unknown, role: string): OverrideEntry {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new ModelsJsonError(`models.json: overrides['${role}'] must be an object`);
	}
	const o = raw as Record<string, unknown>;
	rejectUnknownKeys(o, OVERRIDE_ENTRY_KEYS, `overrides['${role}']`);
	const model_id = requireString(o.model_id, `overrides['${role}'].model_id`);
	const agent_slug = requireSlug(o.agent_slug, `overrides['${role}'].agent_slug`);
	return { model_id, agent_slug };
}

function rejectUnknownKeys(obj: Record<string, unknown>, known: Set<string>, ctx: string): void {
	const extra = Object.keys(obj).filter((k) => !known.has(k));
	if (extra.length > 0) {
		throw new ModelsJsonError(
			`models.json: ${ctx} has unknown field(s): ${extra.join(", ")}`,
		);
	}
}

function requireString(value: unknown, path: string): string {
	if (typeof value !== "string" || value.length === 0) {
		throw new ModelsJsonError(`models.json: ${path} must be a non-empty string`);
	}
	return value;
}

function requireSlug(value: unknown, path: string): string {
	const s = requireString(value, path);
	if (!SAFE_SLUG.test(s)) {
		throw new ModelsJsonError(
			`models.json: ${path} must match /^[a-z0-9_-]+$/i (letters, digits, underscore, hyphen); got ${JSON.stringify(s)}`,
		);
	}
	return s;
}
