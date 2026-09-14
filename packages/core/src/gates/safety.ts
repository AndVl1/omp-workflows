/**
 * Safety guard. Replaces claude-plugin's `safety-guard.sh` PreToolUse hook.
 *
 * Blocks:
 *   - writes to protected branches (main, production)
 *   - edits to sensitive files (.env, credentials, *.pem, *.key, secrets)
 *   - bash commands matching destructive patterns (rm -rf /, etc.)
 *
 * Wired to `tool_call`. The handler reads the tool name and inputs from
 * the event; failure-mode is fail-closed (the original claude-plugin default).
 */

import { execSync } from "node:child_process";

interface ToolCallEvent {
  toolName: string;
  input?: Record<string, unknown>;
}

interface ToolCallContext {
  cwd: string;
}

const PROTECTED_BRANCHES = new Set(["main", "master", "production", "prod"]);
const SENSITIVE_PATH_PATTERNS = [
  /(^|\/)\.env(\.|$)/i,
  /(^|\/)credentials\.(json|ya?ml|toml)/i,
  /(^|\/)\.npmrc$/i,
  /(^|\/)\.netrc$/i,
  /(^|\/)\.aws\/credentials$/i,
  /(^|\/)\.ssh\//i,
  /(^|\/)\.gnupg\//i,
  /(^|\/)\.pypirc$/i,
  /\.pem$/i,
  /\.key$/i,
  /\.p12$/i,
  /id_rsa/i,
  /id_dsa/i,
  /id_ed25519/i,
  /id_ecdsa/i,
];

const DESTRUCTIVE_BASH_PATTERNS = [
  /\brm\s+-rf\s+\/(?:\s|$)/,
  /\brm\s+-rf\s+~\//,
  /\bdd\s+if=\/dev\/zero\b/,
  /\bmkfs\b/,
  /\b:(){\s*:\|:&\s*};:\s*$/,
  /\bchmod\s+-R\s+777\s+\/(?:\s|$)/,
  /\bcurl\s+.*\|\s*sudo\s+bash\b/,
  /\bwget\s+.*\|\s*sudo\s+bash\b/,
];

export function safetyGuard(event: ToolCallEvent, ctx: ToolCallContext): { block?: boolean; reason?: string } | void {
  if (event.toolName === "bash") {
    return checkBash(event.input, ctx);
  }
  if (event.toolName === "write" || event.toolName === "edit") {
    return checkWrite(event.input, ctx);
  }
  return;
}


const FORCE_PUSH_BRANCH_UNAVAILABLE_REASON =
  "safety-guard: refusing to force-push because the current branch could not be established.";

function checkBash(input: Record<string, unknown> | undefined, ctx: ToolCallContext): { block?: boolean; reason?: string } | void {
  const cmd = String(input?.command ?? "");
  if (!cmd) return;
  for (const pattern of DESTRUCTIVE_BASH_PATTERNS) {
    if (pattern.test(cmd)) {
      return { block: true, reason: `safety-guard: destructive bash pattern blocked (${pattern}). Refusing to execute.` };
    }
  }
  if (!/\bgit\s+push\b/i.test(cmd) || !/(?:^|\s)(?:--force(?:-with-lease)?|-f)(?:=|\s|$)/i.test(cmd)) return;
  const branch = currentBranchSafe(ctx.cwd);
  if (branch === null) return { block: true, reason: FORCE_PUSH_BRANCH_UNAVAILABLE_REASON };
  if (PROTECTED_BRANCHES.has(branch)) return { block: true, reason: `safety-guard: refusing to force-push to protected branch '${branch}'.` };
}

function checkWrite(input: Record<string, unknown> | undefined, _ctx: ToolCallContext): { block?: boolean; reason?: string } | void {
  const path = input?.path ?? input?.file_path;
  if (typeof path !== "string") return;
  for (const pattern of SENSITIVE_PATH_PATTERNS) {
    if (pattern.test(path)) {
      return { block: true, reason: `safety-guard: refusing to write to sensitive path '${path}'.` };
    }
  }
}


function currentBranchSafe(cwd: string): string | null {
  try {
    const branch = execSync("git symbolic-ref --short HEAD", { cwd, encoding: "utf8" }).trim();
    if (!branch || branch === "HEAD") return null;
    return branch;
  } catch {
    return null;
  }
}
