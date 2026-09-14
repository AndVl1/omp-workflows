import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fullstackExtension from "../src/index.js";
import { writeFullstackActivationMarker } from "../src/activation-marker.js";
import {
  loadAllProfiles,
  resolveWorkflow,
  selectProfile,
} from "@andvl1/omp-workflows-core";

const here = dirname(fileURLToPath(import.meta.url));

function makeActivatedRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  execFileSync("git", ["-C", root, "init", "--quiet", "--initial-branch", "main"], { stdio: "ignore" });
  writeFullstackActivationMarker(root);
  return root;
}

test("fullstack: activated registration exposes regression roles and core profiles for every classification", async () => {
  const root = makeActivatedRoot("omp-fullstack-integration-");
  const calls: Array<{ kind: string; value: string }> = [];
  const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
  const tools: unknown[] = [];
  const fakePi = {
    on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => {
      const current = handlers.get(name) ?? [];
      current.push(handler);
      handlers.set(name, current);
      calls.push({ kind: "event", value: name });
    },
    setLabel: (value: string) => calls.push({ kind: "label", value }),
    registerCommand: (name: string) => calls.push({ kind: "command", value: name }),
  };
  const sessionContext = {
    cwd: root,
    hasUI: true,
    sessionManager: {
      getCwd: () => root,
      getSessionId: () => "fullstack-integration-session",
    },
  };
  try {
    fullstackExtension(fakePi as never);
    const sessionStarts = [...(handlers.get("session_start") ?? [])];
    assert.ok(sessionStarts.length >= 2, "command and fullstack activation handlers are both registered");
    for (const handler of sessionStarts) handler({}, sessionContext);

    assert.ok(calls.some(call => call.kind === "command" && call.value === "do-work"));
    assert.ok(calls.some(call => call.kind === "command" && call.value === "team"));
    assert.ok(calls.some(call => call.kind === "command" && call.value === "cto"));
    assert.equal(calls.find((call) => call.kind === "label")?.value, "omp-workflows-fullstack");
    for (const [file, role] of [["analyst.md", "analyst"], ["manual-qa.md", "manual-qa"], ["qa.md", "qa"]] as const) {
      const frontmatter = readFileSync(resolve(here, "..", "agents", file), "utf8");
      assert.match(frontmatter, new RegExp(`name:\\s*${role}`));
    }

    const profiles = await loadAllProfiles();
    for (const type of ["SPEC", "REGRESS"] as const) {
      for (const complexity of ["QUICK", "MEDIUM", "COMPLEX", "CRITICAL"] as const) {
        for (const autonomous of [false, true]) {
          const workflow = resolveWorkflow(type, complexity, autonomous);
          const selected = selectProfile(profiles, {
            type,
            complexity,
            confidence: "HIGH",
            autonomous,
            workflow,
          });
          assert.equal(selected?.name, workflow, `${type}/${complexity}/${autonomous} profile is available`);
        }
      }
    }
  } finally {
    for (const handler of handlers.get("session_shutdown") ?? []) handler({}, sessionContext);
    rmSync(root, { recursive: true, force: true });
  }
});

test("fullstack: published package layout contains registered bundle surfaces", () => {
  const manifest = JSON.parse(readFileSync(resolve(here, "..", "package.json"), "utf8")) as {
    files?: string[];
    exports?: Record<string, unknown>;
  };
  for (const directory of ["dist", "agents", "skills", "commands", "bin", "scripts"]) {
    assert.ok(manifest.files?.includes(directory), `published package must include ${directory}`);
  }
  assert.equal(manifest.exports?.["./commands"], "./commands/");
  assert.equal(manifest.exports?.["./commands/*"], "./commands/*");
});
