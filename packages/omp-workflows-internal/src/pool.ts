/**
 * Allowed agent pool and workflow role/scope/flag taxonomy for the private
 * OMP bundle. Defined HERE, not imported from fullstack: this bundle is a
 * single-writer fork of the composition surface with a deliberately narrowed
 * pool. Kotlin, Go, frontend, mobile and Rust writer roles are excluded.
 */

import type { RoleConfig, ScopeRuntimeClassTable } from "@andvl1/omp-workflows-core";

/** The complete allowed pool — every agent shipped in agents/. */
export const ALLOWED_POOL_AGENTS: readonly string[] = [
	"omp-team-lead",
	"omp-analyst",
	"omp-tech-researcher",
	"omp-diagnostics",
	"omp-architect",
	"omp-qa",
	// Pool-only (finding F1): no scope trigger references manual-qa in this
	// bundle's profiles — nothing under a TS monorepo can set has_ui. It stays
	// available for orchestrator-initiated validation tasks.
	"omp-manual-qa",
	"omp-code-reviewer",
	"omp-security-tester",
	// Conditional: joined only when scope flags (e.g. has_infra) demand it.
	"omp-devops",
	// Custom specialists for this TypeScript/OMP monorepo domain.
	"omp-plugin-developer",
	"omp-engine-specialist",
	"omp-host-integration-specialist",
	"omp-package-release-specialist",
];

/**
 * Workflow role → agent mapping. Keys are the role names referenced by
 * workflow profiles and gates; values are hyphen-prefixed omp-* agents.
 */
export const defaultOmpInternalRoles: RoleConfig["roles"] = {
	"team-lead": "omp-team-lead",
	analyst: "omp-analyst",
	"tech-researcher": "omp-tech-researcher",
	diagnostics: "omp-diagnostics",
	architect: "omp-architect",
	architect_minimal: "omp-architect",
	architect_clean: "omp-architect",
	architect_pragmatic: "omp-architect",
	developer: "omp-engine-specialist",
	qa: "omp-qa",
	"manual-qa": "omp-manual-qa",
	"code-reviewer": "omp-code-reviewer",
	"security-tester": "omp-security-tester",
	devops: "omp-devops",
	"plugin-developer": "omp-plugin-developer",
	"host-integration": "omp-host-integration-specialist",
	"package-release": "omp-package-release-specialist",
};
/**
 * Scope map. Deliberately excludes rust/kotlin/go/frontend/mobile domains:
 * `${scope.dev_agent}` resolution maps onto bundle generalists instead of
 * domain writers that do not exist in this pool.
 */
export const defaultOmpInternalScopeMap: RoleConfig["scope_map"] = [
	{
		glob: ["**/Dockerfile", "**/*.yaml", "**/*.yml", "**/helm/**", "**/.github/workflows/**"],
		scope: "devops",
		dev_agent: "omp-devops",
	},
	{
		// INT-001: core no longer classifies scopes by built-in domain tables,
		// so this bundle supplies its own runtime classes explicitly.
		glob: ["packages/**/*.ts", "*.ts", "*.json"],
		scope: "dev",
		dev_agent: "omp-engine-specialist",
	},
];

/** Bundle-owned classification (INT-001): devops and TS sources are runnable; no UI scopes exist here. */
export const defaultOmpInternalScopeRuntimeClasses: ScopeRuntimeClassTable = {
	devops: "runtime",
	dev: "runtime",
};

export const defaultOmpInternalScopeUiClasses: ScopeRuntimeClassTable = {};

/** Conditional roster triggers reused by profile `conditional` stages. */
export const defaultOmpInternalFlags: RoleConfig["flags"] = {
	has_security: ["**/auth/**", "**/security/**", "**/*crypto*", "**/*Secret*", "**/*Token*"],
	has_infra: ["**/Dockerfile", "**/helm/**", "**/k8s/**", "**/.github/workflows/**"],
};
