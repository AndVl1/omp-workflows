#!/usr/bin/env node
/**
 * Install-time entry point for the project-local compatibility command copier.
 * The hardened no-follow/root-pinned implementation lives in the package
 * runtime (`dist/copy-commands.js`) and is retained for explicit legacy
 * compatibility/bootstrap calls. Supported extension sessions register
 * commands directly and do not invoke this launcher.
 * Keeping this file as a thin launcher avoids a second, weaker filesystem
 * implementation in the published package.
 */

import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

const projectRoot = process.env.OMP_PROJECT_DIR
  || process.env.INIT_CWD
  || process.argv[2]
  || process.cwd();
const implementationPath = resolve(fileURLToPath(new URL("../dist/copy-commands.js", import.meta.url)));

let copyCommandsForInstall;
try {
  ({ copyCommandsForInstall } = await import(implementationPath));
} catch (error) {
  console.error(`copy-commands: hardened runtime is unavailable at ${implementationPath}: ${String(error)}`);
  process.exit(1);
}

const result = copyCommandsForInstall(projectRoot);
for (const name of result.copied) console.log(`copy-commands: copied ${name}`);
for (const name of result.skipped) console.log(`copy-commands: skipped ${name}`);
for (const error of result.errors) console.error(`copy-commands: ${error}`);
if (result.errors.length > 0) process.exitCode = 1;
else console.log("copy-commands: done");
