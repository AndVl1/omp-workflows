import { resolve } from "node:path";

interface BashEvent {
  toolName: string;
  input?: unknown;
}

/** Single-command AST lookup/index refresh, never a general shell capability. */
export function isAllowedAstIndexBash(input: BashEvent["input"], trustedCwd?: string): boolean {
  let command: unknown;
  try {
    if (typeof input === "string") command = input;
    else {
      if (!input || typeof input !== "object" || Object.getPrototypeOf(input) !== Object.prototype) return false;
      const descriptor = Object.getOwnPropertyDescriptor(input, "command");
      if (!descriptor || !("value" in descriptor)) return false;
      command = descriptor.value;
      // In particular, AST_INDEX_DB_PATH and root selectors cannot be injected.
      if ("env" in input) return false;
      if ("cwd" in input) {
        const cwd = Object.getOwnPropertyDescriptor(input, "cwd");
        if (!cwd || !("value" in cwd) || typeof cwd.value !== "string" || !trustedCwd || resolve(trustedCwd, cwd.value) !== resolve(trustedCwd)) return false;
      }
    }
  } catch {
    return false;
  }
  if (typeof command !== "string" || !command.trim() || /[^A-Za-z0-9_./:@=+ -]/.test(command)) return false;
  const words = command.trim().split(/ +/);
  const binary = words[0];
  if (binary !== "ast-index" && binary !== "/opt/homebrew/bin/ast-index" && binary !== "/usr/local/bin/ast-index") return false;
  let cursor = 1;
  if (words[cursor] === "--format") {
    if (words[cursor + 1] !== "json" && words[cursor + 1] !== "text") return false;
    cursor += 2;
  }
  const operation = words[cursor++];
  if (operation === "--help" || operation === "-h" || operation === "--version" || operation === "-V" || operation === "version" || operation === "stats") return cursor === words.length;
  if (operation === "rebuild" || operation === "update") return cursor === words.length;
  if (operation === "help") return cursor === words.length;
  if (operation !== "search" && operation !== "file" && operation !== "symbol" && operation !== "refs" && operation !== "outline" && operation !== "imports") return false;
  if (words[cursor] === "--") cursor++;
  const argument = words[cursor++];
  if (!argument || argument.startsWith("-")) return false;
  if (cursor === words.length) return true;
  if (operation === "outline" || operation === "imports") return false;
  if (words[cursor++] !== "--limit") return false;
  const limit = words[cursor++];
  return cursor === words.length && typeof limit === "string" && /^(?:[1-9][0-9]{0,3}|10000)$/.test(limit);
}

export function readOnlyWorkerBashGate(event: BashEvent, trustedCwd?: string): { block?: boolean; reason?: string } | void {
  if (event.toolName === "bash" && !isAllowedAstIndexBash(event.input, trustedCwd)) {
    return { block: true, reason: "read-only worker bash: only allowlisted ast-index lookup, rebuild and update commands are permitted; shell composition, env/root overrides and source mutations are denied" };
  }
}
