/**
 * Orchestrator write policy gate.
 *
 * The OMP tool event does not expose the active agent identity, so the
 * user-controlled `actor`/`__omp_actor` input fields are never authorization
 * credentials. Runtime context is authoritative: interactive contexts are
 * orchestrators, non-UI subagent contexts are workers, and unknown contexts
 * fail closed for strict-state writes.
 */
import { isAbsolute, relative, resolve, dirname, join, sep } from "node:path";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
interface ToolCallEvent {
  toolName: string;
  input?: Record<string, unknown> | string;
}
const REGISTERED_LIFECYCLE_DEVICE_ROUTES = new Set([
  "xd://workflow_prepare",
  "xd://workflow_instructions",
  "xd://workflow_begin",
  "xd://workflow_status",
  "xd://workflow_complete",
  "xd://workflow_checkpoint",
  "xd://workflow_checkpoint_ask",
  "xd://workflow_advance",
]);

type Actor = "orchestrator" | "worker" | "lead";

/**
 * Internal proof attached by the core host adapter after authenticating the
 * current session. The unique symbol keeps model/tool input and ordinary
 * runtime context fields from manufacturing the narrowed orchestrator scope.
 */
export const TRUSTED_ORCHESTRATOR_WRITE_PROOF = Symbol("trusted-orchestrator-write-proof");
export interface TrustedOrchestratorWriteProof {
  readonly [TRUSTED_ORCHESTRATOR_WRITE_PROOF]: true;
  readonly artifactsDir: string;
}

export function createTrustedOrchestratorWriteProof(artifactsDir: string): TrustedOrchestratorWriteProof {
  const root = resolve(artifactsDir);
  return Object.freeze({
    [TRUSTED_ORCHESTRATOR_WRITE_PROOF]: true as const,
    artifactsDir: root,
  });
}

interface ToolCallContext {
  cwd: string;
  run_id?: string;
  hasUI?: boolean;
  actor?: Actor;
  [TRUSTED_ORCHESTRATOR_WRITE_PROOF]?: TrustedOrchestratorWriteProof;
}

export function orchestratorWriteGate(
  event: ToolCallEvent,
  ctx: ToolCallContext,
): { block?: boolean; reason?: string } | void {
  if (!hasStrictOrchestratorState(ctx.cwd, ctx.run_id)) return;
  if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") return;
  // Registered lifecycle devices use the generic write transport, but only
  // exact route writes are exempt from project-write policy.
  if (isRegisteredLifecycleDeviceWrite(event)) return;
  const actor = trustedActorOf(ctx);
  const bashSnapshot = event.toolName === "bash" ? bashProofInput(event.input) : undefined;
  const bashCommand = event.toolName === "bash" && bashSnapshot?.valid ? bashSnapshot.command : "";

  // A proof-derived artifact scope is deliberately a positive allowlist:
  // only the exact sanitized read-only git prefix
  // `GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false` may run
  // through bash; diff/show additionally require --no-ext-diff and --no-textconv.
  const artifactsDir = trustedArtifactsDirOf(ctx, actor);
  if (event.toolName === "bash" && artifactsDir) {
    if (!bashSnapshot?.valid || !isReadOnlyProofCommand(bashSnapshot.command, bashSnapshot.env, bashSnapshot.hasEnv)) {
      return { block: true, reason: "orchestrator policy: trusted host artifact proof permits only sanitized read-only git inspection with GIT_OPTIONAL_LOCKS=0 git --no-pager -c core.fsmonitor=false; diff/show also require --no-ext-diff --no-textconv" };
    }
  }

  if (event.toolName === "bash" && !bashSnapshot?.valid) {
    return { block: true, reason: "orchestrator policy: malformed bash input" };
  }
  if (event.toolName === "bash") {
    const command = bashCommand;
    const targets = bashMutationTargets(command);
    const canonical = targets.find((path) => isCanonicalStatePath(path, ctx.cwd));
    if (canonical || looksLikeWorkflowStateMutation(command)) {
      return { block: true, reason: `orchestrator policy: canonical workflow state is engine-owned; refused bash mutation${canonical ? ` '${canonical}'` : ""}` };
    }
    const projectTarget = targets.find((path) => isProjectPath(path, ctx.cwd) && !isWorkStatePath(path, ctx.cwd));
    if (projectTarget && actor !== "worker") {
      return { block: true, reason: `orchestrator policy: source mutation via bash requires a trusted worker actor; got ${actor ?? "unknown"}` };
    }
    if (looksLikeSourceMutation(command) && actor !== "worker") {
      return { block: true, reason: `orchestrator policy: source mutation via bash requires a trusted worker actor; got ${actor ?? "unknown"}` };
    }
    return;
  }

  const paths = pathsFromInput(event.input);
  if (paths.length === 0) {
    return { block: true, reason: `orchestrator policy: ${actor ?? "unknown"} write/edit has no verifiable path` };
  }
  const canonical = paths.find((path) => isCanonicalStatePath(path, ctx.cwd));
  if (canonical) {
    return { block: true, reason: `orchestrator policy: canonical workflow state is engine-owned; refused '${canonical}'` };
  }
  if (actor === "worker") return;
  if (actor !== "orchestrator" && actor !== "lead") {
    return { block: true, reason: "orchestrator policy: trusted actor identity is required for source writes" };
  }
  if (artifactsDir) {
    const invalid = paths.find((path) => !isArtifactPath(path, ctx.cwd, artifactsDir));
    if (invalid) {
      return { block: true, reason: `orchestrator policy: trusted host may write only under the selected artifacts directory; refused '${invalid}'` };
    }
    return;
  }
  const invalid = paths.find((path) => !isWorkStatePath(path, ctx.cwd));
  if (invalid) {
    return { block: true, reason: `orchestrator policy: ${actor} may write only under .work-state; refused '${invalid}'` };
  }
}

function trustedActorOf(ctx: ToolCallContext): Actor | undefined {
  if (ctx.actor === "orchestrator" || ctx.actor === "worker" || ctx.actor === "lead") return ctx.actor;
  if (ctx.hasUI === true) return "orchestrator";
  if (ctx.hasUI === false) return "worker";
  return undefined;
}

function trustedArtifactsDirOf(ctx: ToolCallContext, actor: Actor | undefined): string | undefined {
  if (actor !== "orchestrator") return undefined;
  const proof = ctx[TRUSTED_ORCHESTRATOR_WRITE_PROOF];
  return proof?.[TRUSTED_ORCHESTRATOR_WRITE_PROOF] === true ? proof.artifactsDir : undefined;
}


/** Diagnostic parser only. Values from tool input are never authorization. */
function simpleGitWords(command: string): string[] | undefined {
  const trimmed = command.trim();
  if (!trimmed || /[\u0000-\u001f\u007f"'\\`;&|<>()$*?[\]{}!]/.test(trimmed)) return undefined;
  const words = trimmed.split(/\s+/);
  if (words.some((word) => !/^[A-Za-z0-9._/@:+~^=-]+$/.test(word))) return undefined;
  return words;
}

function splitGitArgs(args: string[], options: ReadonlySet<string>): { before: string[]; after: string[] } | undefined {
  const separator = args.indexOf("--");
  const before = separator < 0 ? args : args.slice(0, separator);
  const after = separator < 0 ? [] : args.slice(separator + 1);
  if (before.some((arg) => arg.startsWith("-") && !options.has(arg))) return undefined;
  if (before.some((arg) => !arg.startsWith("-") && !/^[A-Za-z0-9._/@:+~^-]+$/.test(arg))) return undefined;
  if (after.some((arg) => !/^[A-Za-z0-9._/@:+~^-]+$/.test(arg))) return undefined;
  return { before, after };
}

/** Bounded read-only git grammar for trusted artifact-proof bash. */
function isReadOnlyProofCommand(command: string, env: unknown, hasEnv: boolean): boolean {
  const words = simpleGitWords(command);
  const inlinePrefix = ["GIT_OPTIONAL_LOCKS=0", "git", "--no-pager", "-c", "core.fsmonitor=false"];
  const structuredPrefix = ["git", "--no-pager", "-c", "core.fsmonitor=false"];
  if (!words) return false;
  if (hasEnv && !isExactSafeGitEnv(env)) return false;
  const matches = (prefix: string[]): boolean =>
    words.length >= prefix.length + 1 && prefix.every((word, index) => words[index] === word);
  const inlineMatch = matches(inlinePrefix);
  const structuredMatch = hasEnv && matches(structuredPrefix);
  const prefixLength = inlineMatch
    ? inlinePrefix.length
    : structuredMatch
      ? structuredPrefix.length
      : undefined;
  if (prefixLength === undefined) return false;
  const subcommand = words[prefixLength]!;
  const args = words.slice(prefixLength + 1);
  if (subcommand === "status") {
    const parsed = splitGitArgs(args, new Set(["-b", "-s", "--branch", "--no-renames", "--porcelain", "--short"]));
    return !!parsed && parsed.before.every((arg) => arg.startsWith("-")) && parsed.after.length === 0;
  }
  if (subcommand === "branch") {
    return args.length === 1 && args[0] === "--show-current";
  }
  if (subcommand === "diff") {
    const parsed = splitGitArgs(args, new Set(["--stat", "--name-only", "--name-status", "--no-color", "--no-ext-diff", "--no-textconv"]));
    if (!parsed || parsed.before.filter((arg) => !arg.startsWith("-")).length > 2) return false;
    return parsed.before.includes("--no-ext-diff") && parsed.before.includes("--no-textconv");
  }
  if (subcommand === "show") {
    const parsed = splitGitArgs(args, new Set(["--name-only", "--name-status", "--no-color", "--no-patch", "--oneline", "--stat", "--no-ext-diff", "--no-textconv"]));
    if (!parsed || parsed.before.filter((arg) => !arg.startsWith("-")).length > 1) return false;
    return parsed.before.includes("--no-ext-diff") && parsed.before.includes("--no-textconv");
  }
  if (subcommand === "log") {
    const parsed = splitGitArgs(args, new Set(["-1", "--no-color", "--no-decorate", "--oneline", "--reverse"]));
    if (!parsed || parsed.before.filter((arg) => !arg.startsWith("-")).length > 1) return false;
    return true;
  }
  return false;
}
export function actorOf(input: Record<string, unknown> | undefined): Actor | undefined {
  const raw = input?.__omp_actor ?? input?.actor;
  return raw === "orchestrator" || raw === "worker" || raw === "lead" ? raw : undefined;
}

function commandFromInput(input: ToolCallEvent["input"]): string {
  if (typeof input === "string") return input;
  if (!input) return "";
  return String(input.command ?? "");
}
type BashProofInput = {
  valid: boolean;
  command: string;
  env?: unknown;
  hasEnv: boolean;
};

function invalidBashProofInput(): BashProofInput {
  return { valid: false, command: "", hasEnv: true };
}

function bashProofInput(input: ToolCallEvent["input"]): BashProofInput {
  if (typeof input === "string") return { valid: true, command: input, hasEnv: false };
  if (!input || typeof input !== "object" || Array.isArray(input)) return invalidBashProofInput();
  try {
    if (Object.getPrototypeOf(input) !== Object.prototype) return invalidBashProofInput();
    const commandDescriptor = Object.getOwnPropertyDescriptor(input, "command");
    if (!commandDescriptor || !("value" in commandDescriptor) || commandDescriptor.get !== undefined || commandDescriptor.set !== undefined) {
      return invalidBashProofInput();
    }
    const command = commandDescriptor.value;
    if (typeof command !== "string") return invalidBashProofInput();
    const envDescriptor = Object.getOwnPropertyDescriptor(input, "env");
    if (!envDescriptor) {
      if ("env" in input) return invalidBashProofInput();
      return { valid: true, command, hasEnv: false };
    }
    if (!("value" in envDescriptor) || envDescriptor.get !== undefined || envDescriptor.set !== undefined) return invalidBashProofInput();
    const env = envDescriptor.value;
    return { valid: true, command, env, hasEnv: true };
  } catch {
    return invalidBashProofInput();
  }
}
function isExactSafeGitEnv(env: unknown): boolean {
  try {
    if (!env || typeof env !== "object" || Array.isArray(env) || Object.getPrototypeOf(env) !== Object.prototype) return false;
    const keys = Reflect.ownKeys(env);
    if (keys.length !== 1 || keys[0] !== "GIT_OPTIONAL_LOCKS") return false;
    const descriptor = Object.getOwnPropertyDescriptor(env, "GIT_OPTIONAL_LOCKS");
    if (!descriptor || !("value" in descriptor) || descriptor.get !== undefined || descriptor.set !== undefined) return false;
    const value = descriptor.value;
    return typeof value === "string" && value === "0";
  } catch {
    return false;
  }
}

function pathsFromInput(input: ToolCallEvent["input"]): string[] {
  if (typeof input === "string") return pathsFromPatch(input);

  const paths: string[] = [];
  const raw = input?.path ?? input?.file_path ?? input?.paths;
  if (typeof raw === "string") paths.push(raw);
  if (Array.isArray(raw)) paths.push(...raw.filter((p): p is string => typeof p === "string"));
  if (typeof input?.input === "string") paths.push(...pathsFromPatch(input.input));
  return paths;
}

function pathsFromPatch(patch: string): string[] {
  const paths: string[] = [];
  const header = /^\[([^#\]\r\n]+)#[0-9A-Fa-f]{4}\]\s*$/gm;
  for (const match of patch.matchAll(header)) {
    const path = match[1];
    if (path) paths.push(path);
  }
  return paths;
}

export function isRegisteredLifecycleDeviceWrite(event: ToolCallEvent): boolean {
  if (event.toolName !== "write") return false;
  const paths = pathsFromInput(event.input);
  return paths.length > 0 && paths.every((path) => REGISTERED_LIFECYCLE_DEVICE_ROUTES.has(path));
}

function isWorkStatePath(path: string, cwd: string): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const workState = resolve(cwd, ".work-state");
  const rel = relative(workState, absolute);
  if (rel !== "" && (rel.startsWith(`..${sep}`) || rel === ".." || isAbsolute(rel))) return false;
  try {
    const realRoot = realpathSync(workState);
    const realCandidate = existsSync(absolute)
      ? realpathSync(absolute)
      : resolve(realpathSync(dirname(absolute)), absolute.slice(dirname(absolute).length + 1));
    const realRel = relative(realRoot, realCandidate);
    return realRel === "" || (!realRel.startsWith(`..${sep}`) && realRel !== ".." && !isAbsolute(realRel));
  } catch {
    return false;
  }
}

function isArtifactPath(path: string, cwd: string, artifactsDir: string): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const root = resolve(artifactsDir);
  const lexical = relative(root, absolute);
  if (lexical === "" || lexical.startsWith(`..${sep}`) || lexical === ".." || isAbsolute(lexical)) return false;
  const projectRoot = resolve(cwd);
  const rootFromProject = relative(projectRoot, root);
  if (rootFromProject.startsWith(`..${sep}`) || rootFromProject === ".." || isAbsolute(rootFromProject)) return false;
  try {
    // The proof root itself must be a real directory. In particular, a
    // symlinked artifacts directory is never an authenticated write target.
    let rootCursor = projectRoot;
    for (const segment of rootFromProject.split(sep).filter(Boolean)) {
      rootCursor = join(rootCursor, segment);
      const rootInfo = lstatSync(rootCursor);
      if (rootInfo.isSymbolicLink()) return false;
      if (!rootInfo.isDirectory()) return false;
    }
    const rootInfo = lstatSync(root);
    if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) return false;
    const realRoot = realpathSync(root);
    const isInsideRoot = (candidate: string): boolean => {
      const realRel = relative(realRoot, candidate);
      return realRel !== "" && !realRel.startsWith(`..${sep}`) && realRel !== ".." && !isAbsolute(realRel);
    };

    let current = root;
    for (const segment of lexical.split(sep).filter(Boolean)) {
      current = join(current, segment);
      let info;
      try {
        info = lstatSync(current);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
        return false;
      }
      if (info.isSymbolicLink()) {
        let realLink: string;
        try {
          realLink = realpathSync(current);
        } catch {
          // This includes dangling final symlinks.
          return false;
        }
        if (!isInsideRoot(realLink)) return false;
      }
    }
    return isInsideRoot(realpathSync(absolute));
  } catch {
    return false;
  }
}
function isCanonicalStatePath(path: string, cwd: string): boolean {
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const canonical = (rel: string): boolean =>
    rel === ".active-feature"
    || rel === "team-state.json"
    || rel === "run-control.json"
    || /^features\/[^/]+\/state\.json$/.test(rel)
    || /^cto\/[^/]+\/state\.json$/.test(rel)
    || /^runs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/(?:state\.json|team-state\.md|migration-receipt\.json)$/i.test(rel)
    || /^runs\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\/revisions(?:\/|$)/i.test(rel)
    || /^lifecycle-transactions\/[^/]+(?:\/transaction\.json)?$/.test(rel)
    || /^artifact-transactions\/[^/]+\.json$/.test(rel)
    || /^migrations\/[^/]+\/receipt\.json$/.test(rel);
  const workState = resolve(cwd, ".work-state");
  if (canonical(relative(workState, absolute).split(sep).join("/"))) return true;
  try {
    const realRoot = realpathSync(workState);
    const parent = realpathSync(dirname(absolute));
    const realCandidate = existsSync(absolute) ? realpathSync(absolute) : join(parent, absolute.slice(dirname(absolute).length + 1));
    return canonical(relative(realRoot, realCandidate).split(sep).join("/"));
  } catch {
    return false;
  }
}
function looksLikeWorkflowStateMutation(command: string): boolean {
  const workflowPath = new RegExp(
    String.raw`(?:^|[\s"'\x60/])(?:\./)?\.work-state/(?:team-state\.json|\.active-feature|run-control\.json|features/[A-Za-z0-9._-]+/state\.json|cto/[A-Za-z0-9._-]+/state\.json|lifecycle-transactions/[^\s"'\x60;&|),]+|artifact-transactions/[^\s"'\x60;&|),]+|migrations/[^\s"'\x60;&|),]+|runs/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/(?:state\.json|team-state\.md|migration-receipt\.json|revisions(?:/[^\s"'\x60;&|),]+)?))(?=$|[\s"'\x60;&|),])|(?:^|[\s"'\x60])(?:\./)?(?:team-state\.json|\.active-feature|run-control\.json)(?=$|[\s"'\x60;&|),])`,
    "i",
  );
  if (!workflowPath.test(command) && !hasRelativeWorkflowStateContext(command)) return false;
  return /(?:>|>>|tee\b|(?:cp|mv|install|touch|rm|rmdir|truncate|dd|ln|chmod|rsync|patch|ed|sponge)\b|(?:sed|perl)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|(?:g?awk)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|(?:python(?:3)?|node|ruby)\b[^\n]*(?:-c|--eval)[^\n]*(?:writeFile(?:Sync)?|appendFile(?:Sync)?|write_text|write_bytes|unlink|rename|mkdir|rmdir|remove|replace)\b|(?:python(?:3)?|ruby)\b[^\n]*(?:-c|--eval)[^\n]*open\([^\n)]*,\s*["\'][^"\']*[wax+][^"\']*["\']|git\s+(?:apply|checkout|restore|reset|clean|mv|rm|show|stash)\b)/i.test(command);
}

function hasRelativeWorkflowStateContext(command: string): boolean {
  const cd = /(?:^|[;&|]\s*)cd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi;
  const rootRelative = new RegExp(String.raw`(?:^|[\s"'\x60])(?:\./)?(?:team-state\.json|\.active-feature|(?:features|cto)/[A-Za-z0-9._-]+/state\.json)(?=$|[\s"'\x60;&|),])`, "i");
  const nestedRelative = /(?:^|[\s"'\x60])(?:state\.json|team-state\.md|migration-receipt\.json)(?=$|[\s"'\x60;&|),])/i;
  const ordinaryRun = /[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i;
  const workStateRelative = /(?:^|[\s"'\x60])(?:run-control\.json|lifecycle-transactions\/[^\s"'\x60;&|),]+|artifact-transactions\/[^\s"'\x60;&|),]+)(?=$|[\s"'\x60;&|),])/i;

  for (const match of command.matchAll(cd)) {
    const directory = (match[1] ?? match[2] ?? match[3] ?? "").replace(/\/+$/, "");
    const afterCd = command.slice((match.index ?? 0) + match[0].length);
    if (/(?:^|\/)\.work-state$/.test(directory) && (rootRelative.test(afterCd) || workStateRelative.test(afterCd))) return true;
    if (/(?:^|\/)\.work-state\/runs\/[^/]+$/.test(directory) && ordinaryRun.test(directory.split(/[\\/]/).pop() ?? "") && nestedRelative.test(afterCd)) return true;
    if (/(?:^|\/)\.work-state\/features\/[A-Za-z0-9._-]+$/.test(directory) && nestedRelative.test(afterCd)) return true;
    if (/(?:^|\/)\.work-state\/cto\/[A-Za-z0-9._-]+$/.test(directory) && nestedRelative.test(afterCd)) return true;
  }
  return false;
}
function bashMutationTargets(command: string): string[] {
  const targets: string[] = [];
  const redirection = /(?:^|[\s;&|])>>?\s*(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/g;
  for (const match of command.matchAll(redirection)) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target) targets.push(target);
  }
  const dd = /\bdd\b[^\n]*\bof=(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi;
  for (const match of command.matchAll(dd)) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target) targets.push(target);
  }
  const tee = /(?:^|[;&|]\s*)tee(?:\s+-[^\s]+)*\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/gi;
  for (const match of command.matchAll(tee)) {
    const target = match[1] ?? match[2] ?? match[3];
    if (target) targets.push(target);
  }
  return targets;
}

function isProjectPath(path: string, cwd: string): boolean {
  const root = resolve(cwd);
  const absolute = isAbsolute(path) ? resolve(path) : resolve(cwd, path);
  const rel = relative(root, absolute);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}


const CHECKOUT_PATH_MUTATION = /\bgit\s+checkout\b[^;&|]*(?:--(?:\s|$)|(?:^|\s)(?:\.{1,2}|\/)(?:[\/\s"'`]|$)|(?:^|\s)(?:src|packages|test|tests|app|config)(?:[\/\s"'`]|$))/i;
const CHECKOUT_FORCE_MUTATION = /(?:^|[;&|]\s*)git\s+checkout\b[^;&|]*(?:--force\b|(?:^|\s)-f(?:\s|$|[;&|]))/;
const CHECKOUT_FORCE_BRANCH_MUTATION = /(?:^|[;&|]\s*)git\s+checkout\b[^;&|]*(?:^|\s)-B(?:\s|$|[;&|])/;
const SWITCH_DISCARD_MUTATION = /(?:^|[;&|]\s*)git\s+switch\b[^;&|]*--discard-changes\b/i;
const SWITCH_FORCE_BRANCH_MUTATION = /(?:^|[;&|]\s*)git\s+switch\b[^;&|]*(?:^|\s)-C(?:\s|$|[;&|])/;

/**
 * Detect direct source/worktree mutations that the orchestrator must not perform.
 *
 * Commit/publication and history-integration commands (`git commit`, `git push`,
 * `git fetch`, `git merge`, `git rebase`, `git cherry-pick`, `gh pr create`)
 * reconcile or publish delegated work and are intentionally not matched here.
 * Branch setup is also allowed; only checkout/switch forms that restore or
 * discard worktree contents remain blocked.
 */
function looksLikeSourceMutation(command: string): boolean {
  return /(?:\b(?:tee)\b|\b(?:cat|printf|echo)\b[^\n]*(?:>|>>|<<)|(?:>|>>)\s*(?:\.\/)?(?:src|packages|test|tests|app|config)(?:[\/\s"'`]|$)|\b(?:cp|mv|install|touch|rm|rmdir|mkfifo|mknod|truncate|dd|ln|rsync|patch|ed|sponge)\b|\b(?:sed|perl)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|\b(?:g?awk)\b[^\n]*(?:\s-i(?:\s|$)|--in-place\b)|\bgit\s+(?:apply|restore|reset|clean|mv|rm|stash)\b|\bgit\s+show\b[^\n]*(?:>|>>)\s*(?:\.\/)?(?:src|packages|test|tests|app|config)(?:[\/\s"'`]|$)|\b(?:python(?:3)?|node|ruby)\b[^\n]*(?:-c|--eval)[^\n]*(?:writeFile(?:Sync)?|appendFile(?:Sync)?|write_text|write_bytes|unlink|rename|mkdir|rmdir|remove|replace)\b|(?:python(?:3)?|ruby)\b[^\n]*(?:-c|--eval)[^\n]*open\([^\n)]*,\s*["'][^"']*[wax+][^"']*["'])/i.test(command)
    || CHECKOUT_PATH_MUTATION.test(command)
    || CHECKOUT_FORCE_MUTATION.test(command)
    || CHECKOUT_FORCE_BRANCH_MUTATION.test(command)
    || SWITCH_DISCARD_MUTATION.test(command)
    || SWITCH_FORCE_BRANCH_MUTATION.test(command);
}

export function hasStrictOrchestratorState(cwd: string, runId?: string): boolean {
  if (!runId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(runId)) return false;
  const path = join(resolve(cwd, ".work-state"), "runs", runId, "state.json");
  try {
    const state = JSON.parse(readFileSync(path, "utf8")) as { policy?: { strict_orchestrator?: boolean } };
    return state.policy?.strict_orchestrator === true;
  } catch { return false; }
}

// ── Bounded write_scope experiment (scope 7) ───────────────────────────────
//
// Advisory-only worker path matcher, OFF by default. When enabled it is
// composed AFTER orchestratorWriteGate and can only ADD blocks (narrow the
// paths a worker may write); it can never weaken the orchestrator boundary
// or the canonical-state protection. Shipped defaults keep the single-writer
// model: no write_scope is configured unless a bundle opts in explicitly.

export interface WorkerWriteScope {
  enabled: boolean;
  /** Glob patterns a worker may write (relative to the project root). */
  allow: string[];
  /** Glob patterns a worker may never write (deny wins over allow). */
  deny?: string[];
}

function matchesAnyGlob(path: string, patterns: string[]): boolean {
  const normalized = path.replace(/\\/g, "/");
  for (const pattern of patterns) {
    const candidate = pattern.replace(/\\/g, "/");
    if (candidate === normalized) return true;
    if (candidate.endsWith("/**") && normalized.startsWith(candidate.slice(0, -3))) return true;
    if (candidate.endsWith("/") && normalized.startsWith(candidate)) return true;
    const base = candidate.replace(/\/\*$/u, "");
    if (base !== candidate && (normalized === base || normalized.startsWith(`${base}/`))) return true;
  }
  return false;
}

/**
 * Narrowing gate for worker source writes. Composed after
 * orchestratorWriteGate in `registerTeamWorkflow`; it only ever blocks
 * worker writes outside the declared scope. Non-worker actors and disabled
 * scopes are unaffected.
 */
export function workerWriteScopeGate(
  event: ToolCallEvent,
  ctx: ToolCallContext & { writeScope?: WorkerWriteScope },
): { block?: boolean; reason?: string } | void {
  const scope = ctx.writeScope;
  if (isRegisteredLifecycleDeviceWrite(event)) return;
  if (!scope?.enabled) return;
  if (event.toolName !== "write" && event.toolName !== "edit" && event.toolName !== "bash") return;
  if (trustedActorOf(ctx) !== "worker") return;
  const paths = event.toolName === "bash" ? bashMutationTargets(commandFromInput(event.input)) : pathsFromInput(event.input);
  if (paths.length === 0) return;
  for (const path of paths) {
    const absolute = isAbsolute(path) ? resolve(path) : resolve(ctx.cwd, path);
    const rel = relative(resolve(ctx.cwd), absolute);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return { block: true, reason: `write_scope: worker target '${path}' escapes the project root` };
    }
    if (matchesAnyGlob(rel, scope.deny ?? [])) {
      return { block: true, reason: `write_scope: worker write to '${rel}' is denied by write_scope` };
    }
    if (!matchesAnyGlob(rel, scope.allow)) {
      return { block: true, reason: `write_scope: worker write to '${rel}' is outside the declared write scope` };
    }
  }
}
