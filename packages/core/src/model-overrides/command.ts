/**
 * `runModelOverrides` — the orchestrator for the `/omp-model-overrides` command.
 *
 * Pure logic, no I/O coupling: file operations go through the small
 * `FsAdapter` interface so tests can run against an in-memory FS.
 *
 * The runtime adapter uses `node:fs`; tests provide a map-backed adapter.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CORE_OVERRIDABLE_ROLES,
	validateModelsJson,
	type ModelsJson,
	type ModelEntry,
	type OverrideEntry,
} from "./schema.js";

/** Filesystem operations the command needs. Tests supply an in-memory impl. */
export interface FsAdapter {
	exists(path: string): boolean;
	read(path: string): string;
	write(path: string, content: string): void;
	mkdirp(path: string): void;
}

export const nodeFsAdapter: FsAdapter = {
	exists: (p) => existsSync(p),
	read: (p) => readFileSync(p, "utf8"),
	write: (p, c) => writeFileSync(p, c, "utf8"),
	mkdirp: (p) => mkdirSync(p, { recursive: true }),
};

/** UI hooks. Tests provide a no-op impl. */
export interface UiAdapter {
	notify(message: string, level?: "info" | "warn" | "error"): void;
}

export const noopUi: UiAdapter = { notify: () => {} };

/** Input contract for runModelOverrides. */
export interface RunModelOverridesInput {
	cwd: string;
	fs?: FsAdapter;
	ui?: UiAdapter;
	/** When true, generate agents even if .omp/models.json does not exist. */
	force?: boolean;
	/** If provided, skip the prompt and use these overrides directly. */
	presetOverrides?: Record<string, OverrideEntry>;
	/** Bundled agents directory (defaults to node_modules/@andvl1/omp-workflows-fullstack/.../agents). */
	bundledAgentsDir?: string;
	/** Allow overriding the source-hash filename (used in tests). */
	sourceHashFilename?: string;
}

export interface RunModelOverridesResult {
	status: "wrote" | "skipped" | "noop" | "failed";
	modelsJsonPath: string;
	agentsWritten: Array<{ role: string; agentSlug: string; path: string }>;
	agentsSkipped: Array<{ role: string; agentSlug: string; reason: string }>;
	message: string;
}

/**
 * Orchestrate the full flow.
 *
 * 1. Read .omp/team.config.json (if present) for the team name.
 * 2. If .omp/models.json does not exist and no preset was given:
 *    - if !force: return { status: "noop", ... } with a message
 *    - else: write a fresh models.json with default models + empty overrides
 * 3. For each CORE_OVERRIDABLE_ROLES role with an override:
 *    a. Determine source agent .md path: .omp/agents/<role>.md (project) → bundled.
 *    b. Read source, patch frontmatter (name: agent_slug; model: model_id).
 *    c. Compute SHA-256(models.json + source .md) and compare to .source-hash.
 *    d. If file missing or hash mismatch: write agent .md + .source-hash.
 *    e. Else: record skip.
 *
 * Returned `result` carries enough metadata for the caller to format a
 * human-readable summary.
 */
export function runModelOverrides(input: RunModelOverridesInput): RunModelOverridesResult {
	const fs = input.fs ?? nodeFsAdapter;
	const ui = input.ui ?? noopUi;
	const sourceHashFilename = input.sourceHashFilename ?? ".source-hash";
	const ompDir = resolve(input.cwd, ".omp");
	const modelsJsonPath = join(ompDir, "models.json");
	const projectAgentsDir = join(ompDir, "agents");
	const bundledAgentsDir = input.bundledAgentsDir ?? defaultBundledAgentsDir();

	const modelsJson = readOrInitModelsJson(modelsJsonPath, fs, input.presetOverrides, input.force === true);
	if (modelsJson.kind === "noop") {
		return {
			status: "noop",
			modelsJsonPath,
			agentsWritten: [],
			agentsSkipped: [],
			message: modelsJson.message,
		};
	}
	if (modelsJson.kind === "failed") {
		return {
			status: "failed",
			modelsJsonPath,
			agentsWritten: [],
			agentsSkipped: [],
			message: modelsJson.message,
		};
	}

	const mj = modelsJson.data;
	const nextContent = JSON.stringify(mj, null, 2) + "\n";
	// Idempotent write: skip if the on-disk content already matches.
	// Prevents unnecessary mtime bumps and git diff noise on re-runs.
	if (!fs.exists(modelsJsonPath) || fs.read(modelsJsonPath) !== nextContent) {
		fs.write(modelsJsonPath, nextContent);
		ui.notify(`wrote ${modelsJsonPath}`, "info");
	}
	const agentsWritten: RunModelOverridesResult["agentsWritten"] = [];
	const agentsSkipped: RunModelOverridesResult["agentsSkipped"] = [];

	for (const role of CORE_OVERRIDABLE_ROLES) {
		const override = mj.overrides[role];
		if (!override) continue;

		const source = resolveAgentSource(role, projectAgentsDir, bundledAgentsDir, fs);
		if (!source) {
			agentsSkipped.push({
				role,
				agentSlug: override.agent_slug,
				reason: `no source agent .md found for role '${role}' (looked in ${projectAgentsDir} and ${bundledAgentsDir})`,
			});
			continue;
		}

		const sourceBody = fs.read(source.path);
		const targetDir = join(projectAgentsDir, override.agent_slug);
		const targetPath = join(targetDir, `${override.agent_slug}.md`);
		const hashFilePath = join(targetDir, sourceHashFilename);

		const hash = computeHash(fs.read(modelsJsonPath), sourceBody);
		const existingHash = fs.exists(hashFilePath) ? fs.read(hashFilePath).trim() : null;
		if (existingHash === hash && fs.exists(targetPath)) {
			agentsSkipped.push({ role, agentSlug: override.agent_slug, reason: "up-to-date (hash match)" });
			continue;
		}

		const patched = patchAgentFrontmatter(sourceBody, override.agent_slug, override.model_id);
		fs.mkdirp(targetDir);
		fs.write(targetPath, patched);
		fs.write(hashFilePath, hash + "\n");
		agentsWritten.push({ role, agentSlug: override.agent_slug, path: targetPath });
		ui.notify(`wrote ${targetPath}`, "info");
	}

	return {
		status: "wrote",
		modelsJsonPath,
		agentsWritten,
		agentsSkipped,
		message: formatSummary(modelsJsonPath, agentsWritten, agentsSkipped),
	};
}

// ---------- internals ----------

type ModelsJsonReadResult =
	| { kind: "ok"; data: ModelsJson }
	| { kind: "noop"; message: string }
	| { kind: "failed"; message: string };

function readOrInitModelsJson(
	path: string,
	fs: FsAdapter,
	preset: Record<string, OverrideEntry> | undefined,
	force: boolean,
): ModelsJsonReadResult {
	if (fs.exists(path)) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(fs.read(path));
		} catch (e) {
			return { kind: "failed", message: formatError("parse .omp/models.json", e) };
		}
		try {
			const data = validateModelsJson(parsed);
			return { kind: "ok", data: applyPreset(data, preset) };
		} catch (e) {
			return { kind: "failed", message: formatError("validate .omp/models.json", e) };
		}
	}

	if (!force && preset === undefined) {
		return {
			kind: "noop",
			message: "no .omp/models.json found and no preset provided; pass force=true to initialise one",
		};
	}

	const data: ModelsJson = {
		schema_version: 1,
		models: defaultModelEntries(),
		overrides: preset ?? {},
	};
	return { kind: "ok", data };
}

function applyPreset(data: ModelsJson, preset: Record<string, OverrideEntry> | undefined): ModelsJson {
	if (!preset) return data;
	const allowed = new Set<string>(CORE_OVERRIDABLE_ROLES);
	const next: Record<string, OverrideEntry> = { ...data.overrides };
	for (const [role, value] of Object.entries(preset)) {
		if (!allowed.has(role)) continue;
		next[role] = value;
	}
	return { ...data, overrides: next };
}

function resolveAgentSource(
	role: string,
	projectAgentsDir: string,
	bundledAgentsDir: string,
	fs: FsAdapter,
): { path: string; from: "project" | "bundled" } | null {
	const projectPath = join(projectAgentsDir, `${role}.md`);
	if (fs.exists(projectPath)) return { path: projectPath, from: "project" };
	const bundledPath = join(bundledAgentsDir, `${role}.md`);
	if (fs.exists(bundledPath)) return { path: bundledPath, from: "bundled" };
	return null;
}

/**
 * Replace or insert `name:` and `model:` in the YAML frontmatter of a
 * source agent .md file. The body of the file is preserved verbatim.
 *
 * If the file does not start with a frontmatter block, the patched file
 * gets one prepended.
 */
export function patchAgentFrontmatter(source: string, agentSlug: string, modelId: string): string {
	// Strip a leading UTF-8 BOM (common on Windows-authored files) so the
	// frontmatter regex matches and we do not emit a duplicate block.
	const sourceClean = source.replace(/^\uFEFF/, "");
	const FM = /^---\n([\s\S]*?)\n---\n?/;
	const m = sourceClean.match(FM);
	if (!m || m[1] === undefined) {
		return `---\nname: ${agentSlug}\nmodel: ${modelId}\n---\n\n${sourceClean}`;
	}
	const body = sourceClean.slice(m[0].length);
	const fm = m[1];
	const next = replaceFrontmatterField(replaceFrontmatterField(fm, "name", agentSlug), "model", modelId);
	return `---\n${next}\n---\n${body}`;
}

function replaceFrontmatterField(fm: string, key: string, value: string): string {
	const re = new RegExp(`^${key}:.*$`, "m");
	if (re.test(fm)) return fm.replace(re, `${key}: ${value}`);
	return `${fm}\n${key}: ${value}`;
}

function computeHash(...parts: string[]): string {
	const h = createHash("sha256");
	for (const p of parts) h.update(p);
	return h.digest("hex");
}

function formatError(ctx: string, e: unknown): string {
	const msg = e instanceof Error ? e.message : String(e);
	return `${ctx}: ${msg}`;
}

function formatSummary(
	modelsJsonPath: string,
	written: RunModelOverridesResult["agentsWritten"],
	skipped: RunModelOverridesResult["agentsSkipped"],
): string {
	const lines: string[] = [];
	lines.push(`omp-model-overrides: wrote ${modelsJsonPath}`);
	if (written.length > 0) {
		lines.push("  agents written:");
		for (const a of written) lines.push(`    - ${a.role} -> ${a.path}`);
	}
	if (skipped.length > 0) {
		lines.push("  agents skipped:");
		for (const a of skipped) lines.push(`    - ${a.role} (${a.agentSlug}): ${a.reason}`);
	}
	if (written.length === 0 && skipped.length === 0) {
		lines.push("  no overrides to apply (overrides map is empty)");
	}
	return lines.join("\n");
}

/** Default model entries when initialising a fresh .omp/models.json. */
export function defaultModelEntries(): ModelEntry[] {
	return [
		{ id: "minimax-m3", label: "Minimax-M3 (primary)", provider: "minimax", model_id: "MiniMax/M3", thinking: "auto" },
		{ id: "deepseek-flash", label: "DeepSeek Flash (alternative)", provider: "deepseek", model_id: "deepseek-flash" },
	];
}

/**
 * Best-effort default for the bundled agents directory.
 *
 * At runtime the agents ship inside `@andvl1/omp-workflows-fullstack`:
 * `<pkg>/agents/<role>.md`. When the model-overrides package is consumed
 * via npm, the resolved path is computed from `import.meta.url` relative
 * to this file. For the monorepo dev case, callers pass `bundledAgentsDir`
 * explicitly via `input`.
 */
export function defaultBundledAgentsDir(): string {
	// packages/core/src/model-overrides/command.ts -> ../../../../packages/fullstack/agents
	const here = dirname(fileURLToPath(import.meta.url));
	return resolve(here, "..", "..", "..", "..", "fullstack", "agents");
}
