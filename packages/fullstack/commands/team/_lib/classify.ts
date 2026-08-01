/**
 * Compact classifier + workflow resolver used by the custom-TS commands.
 *
 * Mirrors `packages/core/src/engine/classify.ts` and
 * `packages/core/src/engine/profile.ts` but in a self-contained form so the
 * custom-TS command can boot without the full engine import tree (the
 * extension side takes care of the runtime config; this command only needs
 * enough to pick the right workflow name so the main agent knows what to
 * drive).
 */

export type TaskType = "FEATURE" | "REFACTOR" | "OPS" | "BUG_FIX" | "INVESTIGATION" | "REVIEW" | "HOTFIX";
export type Complexity = "QUICK" | "MEDIUM" | "COMPLEX" | "CRITICAL";
export type Confidence = "HIGH" | "MEDIUM" | "LOW";
export type WorkflowName =
	| "full-feature"
	| "standard"
	| "lightweight"
	| "debug-cycle"
	| "bug-fix"
	| "emergency"
	| "research"
	| "review";

export interface Classification {
	type: TaskType;
	complexity: Complexity;
	confidence: Confidence;
}

const HOTFIX_SIGNALS = /\b(sev-?1|prod down|outage|hotfix|incident|p0|critical outage)\b/i;
const BUG_SIGNALS = /\b(bug|fix|error|broken|regression|stack ?trace|crash|exception)\b/i;
const REFACTOR_SIGNALS = /\b(refactor|rework|rewrite|restructure|clean ?up|move|rename)\b/i;
const OPS_SIGNALS = /\b(deploy|release|ci|cd|infra|helm|kubernetes|docker|terraform|rollback)\b/i;
const INVESTIGATION_SIGNALS =
	/\b(investigate|research|spike|explore|why|how does|understand|compare|benchmark)\b/i;
const REVIEW_SIGNALS = /\b(review|audit|inspect|check)\b/i;
const FEATURE_SIGNALS = /\b(add|implement|create|build|introduce|new|support)\b/i;

export function classifyTask(task: string, opts: { autonomous?: boolean } = {}): Classification {
	const lower = task.toLowerCase();
	let type: TaskType = "FEATURE";
	if (HOTFIX_SIGNALS.test(lower)) type = "HOTFIX";
	else if (BUG_SIGNALS.test(lower)) type = "BUG_FIX";
	else if (REFACTOR_SIGNALS.test(lower)) type = "REFACTOR";
	else if (OPS_SIGNALS.test(lower)) type = "OPS";
	else if (INVESTIGATION_SIGNALS.test(lower)) type = "INVESTIGATION";
	else if (REVIEW_SIGNALS.test(lower)) type = "REVIEW";
	else if (FEATURE_SIGNALS.test(lower)) type = "FEATURE";

	const length = task.length;
	const hasMultipleSubsystems = lower.split(/\b(scope|engine|api|frontend|backend|database|infra)\b/).length > 2;
	const complexity: Complexity =
		length > 600 || hasMultipleSubsystems ? "COMPLEX" : length > 200 ? "MEDIUM" : "QUICK";

	const confidence: Confidence = opts.autonomous ? "HIGH" : "MEDIUM";
	return { type, complexity, confidence };
}

export function resolveWorkflowName(
	type: TaskType,
	complexity: Complexity,
	autonomous: boolean,
): WorkflowName {
	type C = Complexity;
	const matrix: Record<TaskType, Record<C, WorkflowName>> = {
		FEATURE: {
			QUICK: "lightweight",
			MEDIUM: "standard",
			COMPLEX: "full-feature",
			CRITICAL: "full-feature",
		},
		REFACTOR: {
			QUICK: "lightweight",
			MEDIUM: "standard",
			COMPLEX: "full-feature",
			CRITICAL: "full-feature",
		},
		OPS: {
			QUICK: "lightweight",
			MEDIUM: "standard",
			COMPLEX: "full-feature",
			CRITICAL: "emergency",
		},
		BUG_FIX: {
			QUICK: "bug-fix",
			MEDIUM: autonomous ? "debug-cycle" : "standard",
			COMPLEX: "debug-cycle",
			CRITICAL: "emergency",
		},
		INVESTIGATION: {
			QUICK: "research",
			MEDIUM: "research",
			COMPLEX: "standard",
			CRITICAL: "full-feature",
		},
		REVIEW: {
			QUICK: "review",
			MEDIUM: "review",
			COMPLEX: "standard",
			CRITICAL: "full-feature",
		},
		HOTFIX: {
			QUICK: "emergency",
			MEDIUM: "emergency",
			COMPLEX: "debug-cycle",
			CRITICAL: "emergency",
		},
	};
	return matrix[type][complexity];
}
