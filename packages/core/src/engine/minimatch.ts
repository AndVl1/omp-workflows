/**
 * Tiny minimatch implementation. Just enough to cover the scope_map globs used
 * in the project (for example: any kt under src/main, k8s manifests).
 *
 * No external dependency to keep the bundle small and the runtime tests light.
 */

export function minimatch(path: string, pattern: string): boolean {
  const regex = globToRegex(pattern);
  return regex.test(path);
}

function globToRegex(pattern: string): RegExp {
  // Normalize separators (we use forward slashes everywhere — POSIX paths).
  const p = pattern.replace(/\\/g, "/");
  let re = "^";
  let i = 0;
  while (i < p.length) {
    const c = p[i];
    if (c === "*") {
      if (p[i + 1] === "*") {
        // `**` matches across path separators.
        const after = p[i + 2];
        if (after === "/") {
          // `**/` — match any number of directories.
          re += "(?:.*/)?";
          i += 3;
        } else {
          re += ".*";
          i += 2;
        }
      } else {
        // `*` — match anything except a slash.
        re += "[^/]*";
        i += 1;
      }
    } else if (c === "?") {
      re += "[^/]";
      i += 1;
    } else if (c === "." || c === "(" || c === ")" || c === "+" || c === "|" || c === "^" || c === "$" || c === "{" || c === "}" || c === "[") {
      re += "\\" + c;
      i += 1;
    } else {
      re += c;
      i += 1;
    }
  }
  re += "$";
  return new RegExp(re);
}
