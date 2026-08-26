import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import initTeamFactory from "../commands/init-team/index.js";

function project(): { root: string; configPath: string; run(args?: string[]): Promise<string> } {
	const root = mkdtempSync(join(tmpdir(), "init-team-"));
	mkdirSync(join(root, ".omp"), { recursive: true });
	const configPath = join(root, ".omp", "team.config.json");
	const command = initTeamFactory({ cwd: root } as never);
	const run = (args: string[] = []): Promise<string> =>
		command.execute(args, { cwd: root } as never);
	return { root, configPath, run };
}

test("init-team: writes a fresh config into an empty project", async () => {
	const { root, configPath, run } = project();
	try {
		assert.match(await run(), /wrote .*team\.config\.json$/);
		assert.ok(existsSync(configPath));
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("init-team: skips an existing config and explains the re-seed behaviour", async () => {
	const { root, configPath, run } = project();
	try {
		writeFileSync(configPath, `${JSON.stringify({ roles: { backend: "my-rust-agent" } }, null, 2)}\n`);
		const result = await run();
		assert.match(result, /already exists\. Skipping/);
		assert.match(result, /re-seeds it on the next session start/);
		assert.match(readFileSync(configPath, "utf8"), /my-rust-agent/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("init-team: --force regenerates over an existing config", async () => {
	const { root, configPath, run } = project();
	try {
		writeFileSync(configPath, `${JSON.stringify({ roles: { backend: "my-rust-agent" } }, null, 2)}\n`);
		const result = await run(["--force"]);
		assert.doesNotMatch(result, /Skipping/);
		assert.doesNotMatch(readFileSync(configPath, "utf8"), /my-rust-agent/);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
