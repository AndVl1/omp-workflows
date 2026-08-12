import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import fullstackExtension from "../src/index.js";
import {
  loadAllProfiles,
  resolveWorkflow,
  selectProfile,
} from "@andvl1/omp-workflows-core";

const here = dirname(fileURLToPath(import.meta.url));

test("fullstack: registration exposes regression roles and core profiles for every classification", async () => {
  const calls: Array<{ kind: string; value: string }> = [];
  const fakePi = {
    setLabel: (value: string) => calls.push({ kind: "label", value }),
    on: (value: string) => calls.push({ kind: "event", value }),
    registerCommand: (value: string) => calls.push({ kind: "command", value }),
  };

  fullstackExtension(fakePi as never);

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
