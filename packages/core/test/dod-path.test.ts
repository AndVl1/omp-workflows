/**
 * Focused behavioral coverage for the canonical `teams[].dod_path` resolver
 * (engine/dod.ts) and its consumers: CTO integration gate (teamDoDComplete),
 * CTO slice gate (validateSliceDoD), and the session report assembler.
 *
 * Contracts under test:
 *   - `dod_path` works as EITHER a directory containing dod.json OR the
 *     dod.json file itself (plus the default team artifacts dir);
 *   - unsafe paths (traversal, absolute, backslash, NUL, oversize, symlinks)
 *     fail closed with a cause and never echo the untrusted value;
 *   - missing/malformed diagnostics name the resolved file path and the cause.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  readDoDFile,
  readDoDFileSafe,
  resolveDodPath,
  type DodPathResolution,
  type DodSafeFileRead,
} from "../src/engine/dod.js";
import { teamDoDComplete } from "../src/cto/gates.js";
import { validateSliceDoD } from "../src/cto/slice-gate.js";
import { buildSessionReport } from "../src/report/assemble.js";
import { dodBackstop } from "../src/gates/dod-backstop.js";
import { resolveCtoSource } from "../src/report/session-source.js";
import { buildSessionSnapshot } from "../src/visualize/snapshot.js";
import type { CtoState } from "../src/cto/types.js";

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "dod-path-"));
}

function makeState(teams: CtoState["teams"], id = "run-1"): CtoState {
  return {
    schema: 2,
    id,
    task: "t",
    branch: "feat/dod-path",
    autonomous: true,
    plan: {
      id,
      task: "t",
      teams: teams.map((t) => ({ team: t.id, scope: [], slice: t.id, profile: "standard", worktree: "same_branch", depends_on: [] })),
      created_at: "2026-08-29T00:00:00.000Z",
    },
    teams,
    integration: { status: "in_progress" },
    updated_at: "2026-08-29T00:00:00.000Z",
  };
}

const COMPLETE_DOD = JSON.stringify({
  items: [{ id: "d1", source: "implementation", criterion: "c", verify_method: "v", status: "met", evidence: "e" }],
  type_requirements_met: true,
  updated_at: "2026-08-29T00:00:00.000Z",
});

const PENDING_DOD = JSON.stringify({
  items: [{ id: "d1", source: "implementation", criterion: "c", verify_method: "v", status: "pending", evidence: "" }],
  type_requirements_met: true,
  updated_at: "2026-08-29T00:00:00.000Z",
});

// ── resolveDodPath: both forms + default ─────────────────────────────────────

test("dod-path: directory form and file form resolve to the same dod.json file path", () => {
  const root = tmpRoot();
  try {
    const dirForm = resolveDodPath(root, ".work-state/artifacts/lead", "lead");
    assert.deepEqual(dirForm, { ok: true, file: join(root, ".work-state", "artifacts", "lead", "dod.json") });

    const fileForm = resolveDodPath(root, ".work-state/artifacts/lead/dod.json", "lead");
    assert.deepEqual(fileForm, { ok: true, file: join(root, ".work-state", "artifacts", "lead", "dod.json") });

    // A trailing slash on the directory form must not break resolution.
    const trailing = resolveDodPath(root, ".work-state/artifacts/lead/", "lead");
    assert.deepEqual(trailing, dirForm);

    // Unset/empty dod_path falls back to the default team artifacts dir.
    const unset = resolveDodPath(root, undefined, "lead");
    assert.deepEqual(unset, dirForm);
    assert.deepEqual(resolveDodPath(root, "", "lead"), dirForm);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dod-path: a configured path pointing at the wrong kind of node is rejected with the corrective cause", () => {
  const root = tmpRoot();
  try {
    // Directory form, but the configured path is a regular file.
    writeFileSync(join(root, "plain"), "nope");
    const dirAtFile = resolveDodPath(root, "plain", "lead");
    assert.equal(wrongShapeCause(dirAtFile), "regular file");

    // File form, but the configured path is a directory.
    mkdirSync(join(root, "dod.json"), { recursive: true });
    const fileAtDir = resolveDodPath(root, "dod.json", "lead");
    assert.equal(wrongShapeCause(fileAtDir), "directory");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  function wrongShapeCause(res: DodPathResolution): string {
    assert.equal(res.ok, false);
    if (res.ok) throw new Error("expected rejection");
    assert.match(
      res.reason,
      /point at the dod\.json file itself or at the directory containing it|point at the directory containing dod\.json or at the dod\.json file itself/,
    );
    return res.reason.includes("is a regular file") ? "regular file" : "directory";
  }
});

// ── resolveDodPath: fail-closed traversal/shape rejection (no value echo) ────

test("dod-path: unsafe configured paths fail closed with a cause and never echo the value", () => {
  const root = tmpRoot();
  try {
    const cases: Array<[unknown, RegExp]> = [
      ["../escape", /must not contain empty, '\.', or '\.\.' path segments/],
      ["/etc/passwd", /must be a relative path using '\/' separators/],
      ["C:\\temp\\dod.json", /must be a relative path using '\/' separators/],
      ["team\\dod.json", /must be a relative path using '\/' separators/],
      ["bad\0byte", /NUL byte/],
      ["./sneaky", /must not contain empty, '\.', or '\.\.' path segments/],
      [`${"a".repeat(600)}/dod.json`, /exceeds 512 characters/],
      [42, /must be a string/],
    ];
    for (const [configured, cause] of cases) {
      const res = resolveDodPath(root, configured, "lead");
      assert.equal(res.ok, false, `expected rejection for ${JSON.stringify(configured)}`);
      if (res.ok) continue;
      assert.match(res.reason, cause, `cause for ${JSON.stringify(configured)}`);
      assert.equal(res.reason.includes("escape"), false, "unsafe value must not be echoed");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dod-path: symlinked ancestors and symlinked dod.json targets are rejected", () => {
  const root = tmpRoot();
  try {
    // Ancestor symlink: link-dir -> outside-real (both inside root, target dir real).
    mkdirSync(join(root, "outside-real", "team"), { recursive: true });
    writeFileSync(join(root, "outside-real", "team", "dod.json"), COMPLETE_DOD);
    symlinkSync(join(root, "outside-real"), join(root, "link-dir"));
    const viaAncestor = resolveDodPath(root, "link-dir/team", "lead");
    assert.equal(viaAncestor.ok, false);
    if (!viaAncestor.ok) assert.match(viaAncestor.reason, /traverses a symlink/);

    // Symlinked dod.json configured directly (file form) — fail closed.
    writeFileSync(join(root, "real-dod.json"), COMPLETE_DOD);
    symlinkSync(join(root, "real-dod.json"), join(root, "linked-dod.json"));
    const viaFileSymlink = resolveDodPath(root, "linked-dod.json", "lead");
    assert.equal(viaFileSymlink.ok, false);
    if (!viaFileSymlink.ok) assert.match(viaFileSymlink.reason, /traverses a symlink/);

    // Directory form with a symlinked dod.json INSIDE the dir — fail closed.
    mkdirSync(join(root, "team"), { recursive: true });
    symlinkSync(join(root, "real-dod.json"), join(root, "team", "dod.json"));
    const viaDirChildSymlink = resolveDodPath(root, "team", "lead");
    assert.equal(viaDirChildSymlink.ok, false);
    if (!viaDirChildSymlink.ok) assert.match(viaDirChildSymlink.reason, /target is a symlink/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── readDoDFile: actionable missing/malformed diagnostics ────────────────────

test("dod-path: read diagnostics name the resolved file path and the cause", () => {
  const root = tmpRoot();
  try {
    const file = join(root, "dod.json");

    const missing = readDoDFile(file);
    assert.equal(missing.ok, false);
    if (!missing.ok) assert.match(missing.reason, /no dod\.json at .+dod\.json$/);

    writeFileSync(file, "{ nope !!");
    const malformed = readDoDFile(file);
    assert.equal(malformed.ok, false);
    if (!malformed.ok) {
      assert.ok(malformed.reason.includes(file), "reason names the resolved file path");
      assert.match(malformed.reason, /is not valid JSON: /, "reason names the JSON cause");
    }

    const validFile = join(root, "valid.json");
    writeFileSync(validFile, COMPLETE_DOD);
    assert.equal(readDoDFile(validFile).ok, true);

    // Defense in depth: a symlink swapped in AFTER resolution is refused at read time.
    // The fixture must use the file form (basename exactly dod.json): create the
    // real file, resolve it, then swap the resolved target for a symlink.
    mkdirSync(join(root, "late-link"), { recursive: true });
    writeFileSync(join(root, "late-link", "dod.json"), COMPLETE_DOD);
    const resolved = resolveDodPath(root, "late-link/dod.json", "lead");
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;
    rmSync(resolved.file);
    symlinkSync(validFile, resolved.file);
    const viaSymlink = readDoDFile(resolved.file);
    assert.equal(viaSymlink.ok, false);
    if (!viaSymlink.ok) assert.match(viaSymlink.reason, /is a symlink \(refusing to read\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Consumers: CTO integration gate ──────────────────────────────────────────

test("dod-path: integration gate accepts complete DoDs in both forms and rejects unsafe/missing claims", () => {
  const root = tmpRoot();
  try {
    const dirForm = ".work-state/artifacts/frontend";
    mkdirSync(join(root, dirForm), { recursive: true });
    writeFileSync(join(root, dirForm, "dod.json"), COMPLETE_DOD);

    mkdirSync(join(root, ".work-state", "dods"), { recursive: true });
    writeFileSync(join(root, ".work-state", "dods", "dod.json"), COMPLETE_DOD);

    const state = makeState([
      { id: "frontend", status: "done", escalations: {}, dod_path: dirForm },
      { id: "backend", status: "done", escalations: {}, dod_path: ".work-state/dods/dod.json" },
    ]);

    assert.deepEqual(teamDoDComplete(state, "frontend", root), { ok: true }, "directory form");
    assert.deepEqual(teamDoDComplete(state, "backend", root), { ok: true }, "file form");

    // Incomplete DoD names the pending item ids.
    writeFileSync(join(root, dirForm, "dod.json"), PENDING_DOD);
    const pending = teamDoDComplete(state, "frontend", root);
    assert.equal(pending.ok, false);
    if (!pending.ok) assert.match(pending.reason, /DoD: d1/);

    // Malformed DoD names the resolved file path and the cause.
    writeFileSync(join(root, dirForm, "dod.json"), "{ nope !!");
    const malformed = teamDoDComplete(state, "frontend", root);
    assert.equal(malformed.ok, false);
    if (!malformed.ok) {
      assert.ok(malformed.reason.includes(join(root, dirForm, "dod.json")), "names the resolved file path");
      assert.match(malformed.reason, /is not valid JSON/);
    }

    // Traversal fails closed without echoing the value.
    const unsafe = teamDoDComplete(makeState([{ id: "frontend", status: "done", escalations: {}, dod_path: "../escape" }]), "frontend", root);
    assert.equal(unsafe.ok, false);
    if (!unsafe.ok) {
      assert.match(unsafe.reason, /DoD path invalid/);
      assert.equal(unsafe.reason.includes("../escape"), false);
    }

    // Unset dod_path stays an unclaimed DoD.
    const unclaimed = teamDoDComplete(makeState([{ id: "frontend", status: "done", escalations: {} }]), "frontend", root);
    assert.equal(unclaimed.ok, false);
    if (!unclaimed.ok) assert.match(unclaimed.reason, /no dod_path — DoD not claimed/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Consumers: CTO slice gate ────────────────────────────────────────────────

test("dod-path: slice gate validates both forms and names path+cause for missing/malformed", () => {
  const root = tmpRoot();
  try {
    // Directory form (default location) — valid.
    mkdirSync(join(root, ".work-state", "artifacts", "lead"), { recursive: true });
    writeFileSync(join(root, ".work-state", "artifacts", "lead", "dod.json"), COMPLETE_DOD);
    const state = makeState([{ id: "lead", status: "in_progress", escalations: {} }]);
    assert.equal(validateSliceDoD(state, "lead", root), null, "directory form accepted");

    // File form — valid.
    const fileFormDir = join(root, ".work-state", "custom");
    mkdirSync(fileFormDir, { recursive: true });
    writeFileSync(join(fileFormDir, "dod.json"), COMPLETE_DOD);
    state.teams[0]!.dod_path = ".work-state/custom/dod.json";
    assert.equal(validateSliceDoD(state, "lead", root), null, "file form accepted");

    // Missing: names the resolved file path.
    rmSync(join(fileFormDir, "dod.json"));
    const missing = validateSliceDoD(state, "lead", root);
    assert.match(missing ?? "", /slice DoD unreadable: no dod\.json at .+dod\.json$/);

    // Malformed: names the resolved file path + JSON cause.
    writeFileSync(join(fileFormDir, "dod.json"), "{ nope !!");
    const malformed = validateSliceDoD(state, "lead", root);
    assert.match(malformed ?? "", /slice DoD unreadable/);
    assert.ok((malformed ?? "").includes(join(fileFormDir, "dod.json")));
    assert.match(malformed ?? "", /is not valid JSON: /);

    // Empty: names the resolved file path.
    writeFileSync(
      join(fileFormDir, "dod.json"),
      JSON.stringify({ items: [], type_requirements_met: false, updated_at: "2026-08-29T00:00:00.000Z" }),
    );
    assert.match(validateSliceDoD(state, "lead", root) ?? "", /slice DoD empty: .+ has no items/);

    // Traversal: fails closed without echoing the configured value.
    state.teams[0]!.dod_path = "../escape";
    const unsafe = validateSliceDoD(state, "lead", root);
    assert.match(unsafe ?? "", /slice DoD path invalid/);
    assert.equal((unsafe ?? "").includes("../escape"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── Consumers: session report ────────────────────────────────────────────────

test("dod-path: report assembler renders both forms and fails closed on unsafe paths", () => {
  const root = tmpRoot();
  try {
    // File form, outside the default team artifacts dir.
    const alphaFile = join(root, ".work-state", "alpha-file", "dod.json");
    mkdirSync(join(root, ".work-state", "alpha-file"), { recursive: true });
    writeFileSync(alphaFile, COMPLETE_DOD);

    // Directory form, custom location.
    const gammaDir = join(root, "custom-gamma");
    mkdirSync(gammaDir, { recursive: true });
    writeFileSync(join(gammaDir, "dod.json"), COMPLETE_DOD);

    writeRun(root, makeState([
      { id: "alpha", status: "done", escalations: {}, dod_path: ".work-state/alpha-file/dod.json" },
      { id: "beta", status: "done", escalations: {}, dod_path: "../escape" },
      { id: "gamma", status: "done", escalations: {}, dod_path: "custom-gamma" },
    ]));

    const report = buildSessionReport(root, { kind: "cto" });

    const alpha = report.artifacts.find((a) => a.id === "dod" && a.owner === "alpha");
    assert.equal(alpha?.status, "produced");
    assert.equal(alpha?.path, alphaFile);

    const gamma = report.artifacts.find((a) => a.id === "dod" && a.owner === "gamma");
    assert.equal(gamma?.status, "produced");
    assert.equal(gamma?.path, join(gammaDir, "dod.json"));

    assert.equal(report.artifacts.some((a) => a.id === "dod" && a.owner === "beta"), false, "unsafe path produces no artifact");
    assert.ok(
      report.warnings.some((w) => w.startsWith("team beta dod_path unusable:") && !w.includes("../escape")),
      "unsafe dod_path surfaces a fail-closed warning without echoing the value",
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W004-DOD-TOCTOU-004: resolve/read swaps fail closed ──────────────────────

test("dod-path: W004-DOD-TOCTOU-004 a leaf swapped in after resolution cannot be read through", () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), "dod-outside-"));
  try {
    const outsideFile = join(outsideDir, "dod.json");
    writeFileSync(outsideFile, COMPLETE_DOD);
    mkdirSync(join(root, "team"), { recursive: true });
    writeFileSync(join(root, "team", "dod.json"), PENDING_DOD);
    const resolved = resolveDodPath(root, "team/dod.json", "lead");
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;

    // Leaf swapped for a symlink pointing OUTSIDE the run root.
    rmSync(resolved.file);
    symlinkSync(outsideFile, resolved.file);
    const escaped = readDoDFile(resolved.file, { root });
    assert.equal(escaped.ok, false);
    if (!escaped.ok) assert.match(escaped.reason, /is a symlink \(refusing to read\)/);

    // The compat (rootless) form is equally refused at the leaf.
    assert.equal(readDoDFile(resolved.file).ok, false);

    // Leaf swapped for a symlink pointing INSIDE the run root: also refused.
    rmSync(resolved.file);
    symlinkSync(join(root, "team", "other.json"), resolved.file);
    const inside = readDoDFile(resolved.file, { root });
    assert.equal(inside.ok, false);
    if (!inside.ok) assert.match(inside.reason, /is a symlink \(refusing to read\)/);

    // Leaf swapped for a directory.
    rmSync(resolved.file);
    mkdirSync(resolved.file);
    const asDir = readDoDFile(resolved.file, { root });
    assert.equal(asDir.ok, false);
    if (!asDir.ok) assert.match(asDir.reason, /is not a regular file/);

    // Leaf removed after resolution.
    rmSync(resolved.file, { recursive: true });
    const gone = readDoDFile(resolved.file, { root });
    assert.equal(gone.ok, false);
    if (!gone.ok) assert.match(gone.reason, /no dod\.json at/);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("dod-path: W004-DOD-TOCTOU-004 an ancestor swapped to a symlink after resolution is refused", () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), "dod-outside-"));
  try {
    const outsideFile = join(outsideDir, "dod.json");
    writeFileSync(outsideFile, COMPLETE_DOD);
    const teamDir = join(root, ".work-state", "artifacts", "lead");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "dod.json"), PENDING_DOD);
    const resolved = resolveDodPath(root, ".work-state/artifacts/lead", "lead");
    assert.equal(resolved.ok, true);
    if (!resolved.ok) return;

    // Swap the resolved directory for a symlink pointing OUTSIDE the run root.
    rmSync(teamDir, { recursive: true });
    symlinkSync(outsideDir, teamDir);

    // Read-time containment revalidation refuses the escaped file…
    const safe = readDoDFileSafe(root, resolved.file);
    assert.equal(safe.ok, false);
    if (!safe.ok) {
      assert.match(safe.reason, /traverses a symlink|outside the run root/);
      assert.equal(safe.reason.includes(outsideDir), false, "outside path is never echoed");
    }

    // …and the canonical gate fails closed end-to-end on the same state.
    const state = makeState([{ id: "lead", status: "done", escalations: {}, dod_path: ".work-state/artifacts/lead" }]);
    const gate = teamDoDComplete(state, "lead", root);
    assert.equal(gate.ok, false);
    if (!gate.ok) {
      assert.match(gate.reason, /traverses a symlink|outside the run root/);
      assert.equal(gate.reason.includes(outsideDir), false);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("dod-path: W004-DOD-TOCTOU-004 the safe read returns fd-bound bytes/mtime and machine-readable refusals", () => {
  const root = tmpRoot();
  try {
    const file = join(root, "dod.json");
    writeFileSync(file, COMPLETE_DOD);
    const safe = readDoDFileSafe(root, file);
    assert.equal(safe.ok, true);
    if (!safe.ok) return;
    assert.equal(safe.raw, COMPLETE_DOD, "raw text is read from the opened fd");
    assert.equal(safe.bytes, Buffer.byteLength(COMPLETE_DOD));
    assert.equal(typeof safe.mtimeMs, "number");

    // Refusals carry a machine-readable kind next to the safe reason.
    rmSync(file);
    symlinkSync(join(root, "elsewhere.json"), file);
    const refused = readDoDFileSafe(root, file);
    assert.equal(refused.ok, false);
    if (!refused.ok) {
      assert.equal(refused.kind, "symlink");
      assert.match(refused.reason, /is a symlink \(refusing to read\)/);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ── W004-DOD-TOCTOU-004: a FIFO cannot hang the bounded safe read ────────────

/**
 * POSIX FIFO support probe: false when named pipes can be created here, else
 * the reason the FIFO fixture must be skipped (win32, or no mkfifo binary).
 */
function fifoSkipReason(): string | false {
  if (process.platform === "win32") return "POSIX named pipes (FIFOs) are unavailable on win32";
  const probeRoot = mkdtempSync(join(tmpdir(), "dod-fifo-probe-"));
  try {
    const made = spawnSync("mkfifo", [join(probeRoot, "probe.fifo")], { timeout: 5_000 });
    return made.error === undefined && made.status === 0
      ? false
      : `mkfifo is unavailable on this platform (${made.error?.message ?? `exit code ${made.status}`})`;
  } finally {
    rmSync(probeRoot, { recursive: true, force: true });
  }
}

const FIFO_SKIP = fifoSkipReason();

/**
 * The boundedness half of the FIFO proof runs the safe read in a child
 * process under a hard external watchdog: a regression that drops the
 * O_NONBLOCK open flag would block in open() forever, and only the spawn
 * timeout can observe (kill and fail on) a hung synchronous read.
 */
const FIFO_CHILD_SCRIPT = `
import(process.env.DOD_TS_ENTRY).then(({ readDoDFileSafe }) => {
  process.stdout.write(JSON.stringify(readDoDFileSafe(process.env.DOD_FIFO_ROOT, process.env.DOD_FIFO_PATH)));
});
`;

test(
  "dod-path: W004-DOD-TOCTOU-004 a FIFO named dod.json cannot hang the safe read and fails closed",
  { skip: FIFO_SKIP },
  () => {
    const root = tmpRoot();
    const fifo = join(root, "dod.json");
    try {
      const made = spawnSync("mkfifo", [fifo], { timeout: 5_000 });
      assert.equal(made.error, undefined, "mkfifo should create the fixture FIFO");
      assert.equal(made.status, 0, "mkfifo should exit cleanly");

      // Boundedness: the watchdog kills (SIGKILL) and fails the fixture if the
      // safe read ever blocks on the writer-less FIFO instead of returning.
      const child = spawnSync(
        process.execPath,
        ["--import", "tsx", "-e", FIFO_CHILD_SCRIPT],
        {
          cwd: join(dirname(fileURLToPath(import.meta.url)), ".."),
          timeout: 15_000,
          killSignal: "SIGKILL",
          encoding: "utf8",
          env: {
            ...process.env,
            DOD_TS_ENTRY: fileURLToPath(new URL("../src/engine/dod.ts", import.meta.url)),
            DOD_FIFO_ROOT: root,
            DOD_FIFO_PATH: fifo,
          },
        },
      );
      assert.equal(
        child.signal,
        null,
        "safe read hung on the FIFO and had to be killed — open() blocked (O_NONBLOCK missing?)",
      );
      assert.equal(child.status, 0, `safe read child failed: ${child.stderr ?? ""}`);
      const outcome = JSON.parse(child.stdout ?? "") as DodSafeFileRead;
      assert.equal(outcome.ok, false, "a FIFO must fail closed, never parse as DoD");
      if (!outcome.ok) {
        assert.equal(outcome.kind, "not-regular");
        assert.match(outcome.reason, /is not a regular file/);
      }

      // Same behavioral answer in-process: the reader returns promptly with
      // the fail-closed refusal instead of blocking on the writer-less FIFO.
      const direct = readDoDFileSafe(root, fifo);
      assert.equal(direct.ok, false, "a FIFO must fail closed in-process too");
      if (!direct.ok) {
        assert.equal(direct.kind, "not-regular");
        assert.match(direct.reason, /is not a regular file/);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);

// ── W004-DOD-TOCTOU-004: consumers use the one safe read ─────────────────────

test("dod-path: report assembler consumes the single safe read and never reopens a swapped dod path", () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), "dod-outside-"));
  try {
    const outsideFile = join(outsideDir, "dod.json");
    writeFileSync(outsideFile, COMPLETE_DOD);
    const dodsDir = join(root, ".work-state", "dods", "alpha");
    mkdirSync(dodsDir, { recursive: true });
    writeFileSync(join(dodsDir, "dod.json"), COMPLETE_DOD);
    writeRun(root, makeState([{ id: "alpha", status: "done", escalations: {}, dod_path: ".work-state/dods/alpha" }]));

    const before = buildSessionReport(root, { kind: "cto" });
    const dodBefore = before.artifacts.find((a) => a.id === "dod" && a.owner === "alpha");
    assert.equal(dodBefore?.status, "produced");
    assert.equal(dodBefore?.bytes, Buffer.byteLength(COMPLETE_DOD));

    // Swap the leaf for an outside symlink AFTER the write: the canonical
    // resolver refuses the swapped path BEFORE the safe read, so the report
    // emits the unusable dod_path warning, produces no dod artifact, and
    // never embeds the escaped body.
    rmSync(join(dodsDir, "dod.json"));
    symlinkSync(outsideFile, join(dodsDir, "dod.json"));
    const after = buildSessionReport(root, { kind: "cto" });
    const dod = after.artifacts.find((a) => a.id === "dod" && a.owner === "alpha");
    assert.equal(dod, undefined, "a resolver-refused dod_path produces no dod artifact");
    assert.ok(
      after.warnings.some((w) => w.includes("dod_path unusable") && w.includes("symlink")),
      "the unusable dod_path warning names the symlink refusal",
    );
    assert.equal(
      after.warnings.some((w) => w.startsWith("artifact dod (alpha) unreadable:")),
      false,
      "the safe reader is never reached for a resolver-refused path",
    );
    assert.equal(JSON.stringify(after).includes("type_requirements_met"), false, "escaped DoD content never reaches the report");
    assert.equal(JSON.stringify(after).includes(outsideFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("dod-path: snapshot renders dod from the single safe read and refuses swapped files", () => {
  const cwd = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), "dod-outside-"));
  try {
    const dodFile = join(cwd, ".work-state", "cto", "toctou-run", "artifacts", "alpha", "dod.json");
    mkdirSync(join(dodFile, ".."), { recursive: true });
    writeFileSync(dodFile, COMPLETE_DOD);
    writeRun(cwd, makeState([{ id: "alpha", status: "done", escalations: {}, dod_path: ".work-state/cto/toctou-run/artifacts/alpha/dod.json" }], "toctou-run"));
    const entry = resolveCtoSource(cwd, "toctou-run");
    assert.ok(entry, "cto run resolved");
    if (!entry) return;

    const before = buildSessionSnapshot(cwd, entry, "2026-08-29T00:00:00.000Z");
    const dodBefore = before.artifacts.find((a) => a.id === "dod");
    assert.equal(dodBefore?.status, "produced");
    assert.equal(dodBefore?.owner, "alpha");

    // Leaf swapped for an outside symlink after the snapshot fixture is
    // written: the canonical resolver refuses the swapped path BEFORE the
    // plan-time safe read, so the render excludes it entirely.
    const outsideFile = join(outsideDir, "dod.json");
    writeFileSync(outsideFile, COMPLETE_DOD);
    rmSync(dodFile);
    symlinkSync(outsideFile, dodFile);

    const after = buildSessionSnapshot(cwd, entry, "2026-08-29T00:00:00.000Z");
    const dod = after.artifacts.find((a) => a.id === "dod");
    assert.equal(dod, undefined, "a resolver-refused dod_path is never rendered");
    assert.ok(after.warnings.some((w) => w.includes("declared path for dod is not a safe relative path")));
    assert.equal(JSON.stringify(after.artifacts).includes("type_requirements_met"), false, "escaped content is never parsed into the snapshot");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("dod-path: session-stop backstop refuses a symlinked dod.json at the done-claim", () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), "dod-outside-"));
  try {
    const workState = join(root, ".work-state");
    mkdirSync(join(workState, "artifacts"), { recursive: true });
    writeFileSync(join(workState, "team-state.json"), JSON.stringify({
      stage_cursor: "summary",
      pause: { kind: "done" },
      classification: { workflow: "lightweight" },
    }));
    const outsideFile = join(outsideDir, "dod.json");
    writeFileSync(outsideFile, JSON.stringify({
      items: [{ criterion: "criterion", verify_method: "run the focused check", status: "met", evidence: "observed pass" }],
    }));
    // A dod.json symlinked outside the workspace must be refused, not followed.
    symlinkSync(outsideFile, join(workState, "artifacts", "dod.json"));
    const res = dodBackstop({}, { cwd: root });
    assert.equal(res?.decision, "block");
    assert.match(res?.reason ?? "", /is a symlink/);
    assert.equal((res?.reason ?? "").includes(outsideDir), false, "outside path is never echoed");
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

// ── W004-DOD-TOCTOU-004: generic scans never pathname-read dod.json ──────────

test("dod-path: report default-dir dod is safe-read and a swapped leaf fails closed", () => {
  const root = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), "dod-outside-"));
  try {
    const outsideFile = join(outsideDir, "dod.json");
    writeFileSync(outsideFile, COMPLETE_DOD);
    const teamDir = join(root, ".work-state", "artifacts", "alpha");
    mkdirSync(teamDir, { recursive: true });
    writeFileSync(join(teamDir, "dod.json"), COMPLETE_DOD);
    // Unset dod_path: the default team artifacts dir IS the canonical path.
    writeRun(root, makeState([{ id: "alpha", status: "done", escalations: {} }]));

    const before = buildSessionReport(root, { kind: "cto" });
    const dodBefore = before.artifacts.find((a) => a.id === "dod" && a.owner === "alpha");
    assert.equal(dodBefore?.status, "produced");
    assert.equal(dodBefore?.bytes, Buffer.byteLength(COMPLETE_DOD));

    // Swap the default-dir leaf for an outside symlink: the report refuses it
    // through the safe read — no generic pathname fallback, no escaped body.
    rmSync(join(teamDir, "dod.json"));
    symlinkSync(outsideFile, join(teamDir, "dod.json"));
    const after = buildSessionReport(root, { kind: "cto" });
    const dod = after.artifacts.find((a) => a.id === "dod" && a.owner === "alpha");
    assert.equal(dod, undefined, "unsafe default-dir resolution produces no DoD artifact");
    assert.ok(after.warnings.some((w) => w.startsWith("team alpha dod_path unusable:")), "unset dod_path warns like configured unsafe paths");
    assert.equal(JSON.stringify(after).includes("type_requirements_met"), false, "escaped DoD content never reaches the report");
    assert.equal(JSON.stringify(after).includes(outsideFile), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("dod-path: report canonical dod replaces the generic same-id artifact and unsafe paths suppress the fallback", () => {
  const root = tmpRoot();
  try {
    // Team beta: a generic bait dod.json in the default dir AND a configured
    // canonical dod_path elsewhere — the canonical artifact must win.
    const baitDir = join(root, ".work-state", "artifacts", "beta");
    mkdirSync(baitDir, { recursive: true });
    writeFileSync(join(baitDir, "dod.json"), JSON.stringify({ bait: "GENERIC-BAIT" }));
    const canonicalDir = join(root, ".work-state", "dods", "beta");
    mkdirSync(canonicalDir, { recursive: true });
    writeFileSync(join(canonicalDir, "dod.json"), COMPLETE_DOD);

    // Team gamma: an unsafe configured dod_path plus a default-dir bait —
    // fail closed: warning only, no artifact, no generic pathname fallback.
    const gammaDir = join(root, ".work-state", "artifacts", "gamma");
    mkdirSync(gammaDir, { recursive: true });
    writeFileSync(join(gammaDir, "dod.json"), JSON.stringify({ bait: "GAMMA-BAIT" }));

    writeRun(root, makeState([
      { id: "beta", status: "done", escalations: {}, dod_path: ".work-state/dods/beta" },
      { id: "gamma", status: "done", escalations: {}, dod_path: "../escape" },
    ]));

    const report = buildSessionReport(root, { kind: "cto" });
    const dod = report.artifacts.find((a) => a.id === "dod" && a.owner === "beta");
    assert.equal(dod?.status, "produced");
    assert.equal(dod?.path, join(canonicalDir, "dod.json"), "canonical path wins over the generic bait");
    assert.equal(dod?.bytes, Buffer.byteLength(COMPLETE_DOD));
    assert.equal(dod?.summary?.includes("GENERIC-BAIT"), false, "bait content is never embedded");

    const gamma = report.artifacts.find((a) => a.id === "dod" && a.owner === "gamma");
    assert.equal(gamma, undefined, "unsafe dod_path suppresses the generic fallback");
    assert.ok(report.warnings.some((w) => w.startsWith("team gamma dod_path unusable:")));
    assert.equal(JSON.stringify(report.artifacts).includes("GAMMA-BAIT"), false, "generic bait is never pathname-read");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dod-path: snapshot unset-team canonical dod precedes run-local bait and unsafe resolution suppresses the fallback", () => {
  const cwd = tmpRoot();
  const outsideDir = mkdtempSync(join(tmpdir(), "dod-outside-"));
  try {
    // Run-local top-level bait dod.json; unset-dod_path team beta whose
    // canonical default-dir dod.json is the real DoD.
    const runArtifacts = join(cwd, ".work-state", "cto", "remediation", "artifacts");
    mkdirSync(runArtifacts, { recursive: true });
    writeFileSync(join(runArtifacts, "dod.json"), JSON.stringify({ bait: "RUNLOCAL-BAIT" }));
    const betaDir = join(cwd, ".work-state", "artifacts", "beta");
    mkdirSync(betaDir, { recursive: true });
    writeFileSync(join(betaDir, "dod.json"), COMPLETE_DOD);
    writeRun(cwd, makeState([{ id: "beta", status: "done", escalations: {} }], "remediation"));
    const entry = resolveCtoSource(cwd, "remediation");
    assert.ok(entry, "cto run resolved");
    if (!entry) return;

    const session = buildSessionSnapshot(cwd, entry, "2026-08-29T00:00:00.000Z");
    const dods = session.artifacts.filter((a) => a.id === "dod");
    assert.equal(dods.length, 1, "plan ids are globally unique: canonical beats the generic bait");
    assert.equal(dods[0]?.owner, "beta", "unset/default canonical team wins");
    assert.equal(dods[0]?.status, "produced");
    assert.equal(dods[0]?.source?.label, ".work-state/artifacts/beta/dod.json", "canonical default path wins over the run-local bait");
    assert.equal(JSON.stringify(session.artifacts).includes("RUNLOCAL-BAIT"), false, "run-local bait is never pathname-read or embedded");

    // Swap beta's default-dir leaf for an outside symlink: canonical
    // resolution goes unsafe, the dod id is reserved (no generic fallback)
    // and neither the escaped body nor the bait ever reaches the model.
    const outsideFile = join(outsideDir, "dod.json");
    writeFileSync(outsideFile, COMPLETE_DOD);
    rmSync(join(betaDir, "dod.json"));
    symlinkSync(outsideFile, join(betaDir, "dod.json"));
    const after = buildSessionSnapshot(cwd, entry, "2026-08-29T00:00:00.000Z");
    const dodsAfter = after.artifacts.filter((a) => a.id === "dod");
    assert.equal(dodsAfter.length, 0, "unsafe canonical renders nothing and suppresses any generic fallback");
    assert.ok(after.warnings.some((w) => w.includes("declared path for dod is not a safe relative path")));
    assert.equal(JSON.stringify(after.artifacts).includes("RUNLOCAL-BAIT"), false, "bait is still never embedded");
    assert.equal(JSON.stringify(after.artifacts).includes("type_requirements_met"), false, "escaped content is never parsed into the snapshot");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
    rmSync(outsideDir, { recursive: true, force: true });
  }
});

test("dod-path: canonical dod_path under generated visualize output is excluded with no fallback", () => {
  const cwd = tmpRoot();
  try {
    const runArtifacts = join(cwd, ".work-state", "cto", "exclusion-run", "artifacts");
    mkdirSync(runArtifacts, { recursive: true });
    writeFileSync(join(runArtifacts, "dod.json"), JSON.stringify({ bait: "RUNLOCAL-BAIT" }));
    // Canonical dod_path inside generated visualize output (excluded input).
    const vizDir = join(cwd, ".work-state", "visualize", "nested");
    mkdirSync(vizDir, { recursive: true });
    writeFileSync(join(vizDir, "dod.json"), JSON.stringify({ bait: "VISUALIZE-BAIT" }));
    writeRun(cwd, makeState([{ id: "alpha", status: "done", escalations: {}, dod_path: ".work-state/visualize/nested" }], "exclusion-run"));
    const entry = resolveCtoSource(cwd, "exclusion-run");
    assert.ok(entry, "cto run resolved");
    if (!entry) return;

    const session = buildSessionSnapshot(cwd, entry, "2026-08-29T00:00:00.000Z");
    assert.equal(session.artifacts.filter((a) => a.id === "dod").length, 0, "excluded canonical renders no dod artifact");
    assert.ok(session.warnings.some((w) => w.includes("declared path for dod is not a safe relative path")));
    const model = JSON.stringify(session.artifacts);
    assert.equal(model.includes("VISUALIZE-BAIT"), false, "excluded canonical is never read");
    assert.equal(model.includes("RUNLOCAL-BAIT"), false, "reservation blocks the run-local fallback");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("dod-path: vibe-report canonical dod_path is excluded while the default artifacts dod stays produced", () => {
  const cwd = tmpRoot();
  try {
    // vibe-report canonical path (excluded input).
    const vibeDir = join(cwd, "vibe-report", "run-notes");
    mkdirSync(vibeDir, { recursive: true });
    writeFileSync(join(vibeDir, "dod.json"), JSON.stringify({ bait: "VIBE-BAIT" }));
    // Ordinary default artifacts dir stays allowed and produced.
    const betaDir = join(cwd, ".work-state", "artifacts", "beta");
    mkdirSync(betaDir, { recursive: true });
    writeFileSync(join(betaDir, "dod.json"), COMPLETE_DOD);
    writeRun(cwd, makeState([
      { id: "alpha", status: "done", escalations: {}, dod_path: "vibe-report/run-notes" },
      { id: "beta", status: "done", escalations: {} },
    ], "exclusion-vibe"));
    const entry = resolveCtoSource(cwd, "exclusion-vibe");
    assert.ok(entry, "cto run resolved");
    if (!entry) return;

    const session = buildSessionSnapshot(cwd, entry, "2026-08-29T00:00:00.000Z");
    const alphaDod = session.artifacts.find((a) => a.id === "dod" && a.owner === "alpha");
    assert.equal(alphaDod, undefined, "vibe-report canonical is excluded");
    const betaDod = session.artifacts.find((a) => a.id === "dod" && a.owner === "beta");
    assert.equal(betaDod?.status, "produced", "ordinary default artifacts dod remains produced");
    assert.ok(session.warnings.some((w) => w.includes("declared path for dod is not a safe relative path")));
    const model = JSON.stringify(session.artifacts);
    assert.equal(model.includes("VIBE-BAIT"), false, "excluded canonical is never read");
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

function writeRun(cwd: string, state: CtoState): void {
  const dir = join(cwd, ".work-state", "cto", state.id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify(state, null, 2));
}
