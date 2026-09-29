// WorkspaceExecutor.manifest: the reconciliation baseline. It must never
// follow a symlink, never hide a path a per-path ignore check would report,
// and be byte-for-byte deterministic.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import { matchesAny } from "../src/avl/paths.ts";
import { runArgv, scrubbedEnv } from "../src/executors/process.ts";
import { MANIFEST_CAP, WorkspaceExecutor, prunesDirectory } from "../src/executors/workspace.ts";
import { sha256 } from "../src/ledger/canonical.ts";

let base = "";
let root = "";

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gru-manifest-")));
  root = path.join(base, "work");
  fs.mkdirSync(root);
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

function put(relative: string, content: string): void {
  const full = path.join(root, ...relative.split("/"));
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

const manifest = (ignore: readonly string[] = []): Map<string, string> => new WorkspaceExecutor(root, []).manifest(ignore);

describe("entries", () => {
  test("regular files map to the sha256 of their bytes; directories are not entries", () => {
    put("a.txt", "alpha");
    put("src/deep/b.ts", "beta");
    fs.mkdirSync(path.join(root, "empty"));
    assert.deepEqual(
      [...manifest()],
      [
        ["a.txt", sha256("alpha")],
        ["src/deep/b.ts", sha256("beta")],
      ],
    );
  });

  test("symlinks are recorded by target and never followed", () => {
    const outside = path.join(base, "outside");
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(outside, "secret.txt"), "secret");
    put("a.txt", "alpha");
    fs.symlinkSync(outside, path.join(root, "out"));
    fs.symlinkSync("a.txt", path.join(root, "alias.txt"));
    fs.symlinkSync("nowhere", path.join(root, "dangling"));
    const entries = manifest();
    assert.equal(entries.get("out"), `symlink:${outside}`);
    assert.equal(entries.get("alias.txt"), "symlink:a.txt");
    assert.equal(entries.get("dangling"), "symlink:nowhere");
    assert.ok(![...entries.keys()].some((key) => key.startsWith("out/")), "the linked directory is not walked");
  });

  test("a FIFO is recorded without being opened", async () => {
    const made = await runArgv(["mkfifo", path.join(root, "pipe")], { cwd: root, env: scrubbedEnv({}), timeout_ms: 5_000 });
    if (made.exit_code !== 0) return; // no mkfifo on this host
    put("a.txt", "alpha");
    // Opening a FIFO for reading with no writer blocks; reaching the assert proves it was not opened.
    assert.equal(manifest().get("pipe"), "special:fifo");
  });
});

describe("determinism", () => {
  test("keys come out in code-unit order regardless of creation order or walk order", () => {
    for (const name of ["z.txt", "a/b.txt", "a.txt", "B.txt", "a-b/c.txt", "a/a.txt"]) put(name, name);
    const keys = [...manifest().keys()];
    assert.deepEqual(keys, ["B.txt", "a-b/c.txt", "a.txt", "a/a.txt", "a/b.txt", "z.txt"]);
    assert.deepEqual([...manifest()], [...manifest()]);
  });

  test("a hash changes when content changes, and only that hash", () => {
    put("a.txt", "one");
    put("b.txt", "same");
    const first = manifest();
    put("a.txt", "two");
    const second = manifest();
    assert.notEqual(first.get("a.txt"), second.get("a.txt"));
    assert.equal(second.get("a.txt"), sha256("two"));
    assert.equal(first.get("b.txt"), second.get("b.txt"));
  });
});

describe("ignore globs", () => {
  test("ignored directories are pruned and ignored files skipped", () => {
    put("src/index.ts", "code");
    put("node_modules/pkg/index.js", "dep");
    put("packages/app/node_modules/x/y.js", "dep");
    put("debug.log", "log");
    put("logs/today.log", "log");
    const entries = manifest(["node_modules/**", "**/node_modules/**", "*.log"]);
    assert.deepEqual([...entries.keys()], ["logs/today.log", "src/index.ts"]);
  });

  test("a glob that matches a directory's name does not hide the files below it", () => {
    // "*.log" matches the directory "dir.log", but not "dir.log/inner.txt".
    // Pruning it would hide a change a per-path check would report.
    put("dir.log/inner.txt", "inner");
    put("build/out.js", "out");
    const entries = manifest(["*.log", "build"]);
    assert.deepEqual([...entries.keys()], ["build/out.js", "dir.log/inner.txt"]);
  });

  test("pruning is what keeps a large ignored tree under the cap", () => {
    // MANIFEST_CAP + 1 entries under node_modules.
    const heavy = path.join(root, "node_modules");
    fs.mkdirSync(heavy);
    for (let index = 0; index <= MANIFEST_CAP; index++) fs.writeFileSync(path.join(heavy, `f${index}`), "");
    put("src/index.ts", "code");
    assert.deepEqual([...manifest(["node_modules/**"]).keys()], ["src/index.ts"], "pruned: never walked");
    assert.throws(() => manifest(["node_modules/*"]), /more than 50000 entries/, "filtered one by one: walked, and capped");
    assert.throws(() => manifest(), /more than 50000 entries/);
  });
});

describe("prunesDirectory", () => {
  const cases: [string, string[], boolean][] = [
    ["node_modules", ["node_modules/**"], true],
    ["node_modules2", ["node_modules/**"], false],
    ["src/node_modules", ["node_modules/**"], false],
    ["src/node_modules", ["**/node_modules/**"], true],
    ["node_modules", ["**/node_modules/**"], true],
    ["a/node_modules_x", ["**/node_modules/**"], false],
    ["anything", ["**"], true],
    ["deep/er", ["*/**"], true],
    ["abc", ["a**"], true],
    ["src/gen", ["src/**/gen/**"], true],
    ["src/x/gen", ["src/**/gen/**"], true],
    ["src", ["src/**/gen/**"], false],
    ["build", ["build"], false],
    ["dir.log", ["*.log"], false],
    ["node_modules", ["node_modules/*"], false],
    ["coverage", ["coverage/***"], false],
  ];
  for (const [dir, ignore, expected] of cases) {
    test(`${dir} with ${JSON.stringify(ignore)} -> ${expected}`, () => {
      assert.equal(prunesDirectory(dir, ignore), expected);
    });
  }

  test("whenever it prunes, matchesAny agrees for every sampled descendant", () => {
    const globs = [
      "node_modules/**",
      "**/node_modules/**",
      "**",
      "*/**",
      "a**",
      "src/**/gen/**",
      "dist/**",
      "*.log",
      "build",
      "**/*.tmp",
      "x?/**",
      ".git/**",
    ];
    const dirs = ["node_modules", "a/node_modules", "abc", "src", "src/gen", "src/a/gen", "dist", "x1", "xy/z", ".git", "b"];
    const below = ["f", "f.ts", "d/f", ".hidden", "a b/c", "deep/deeper/f.log", "gen/x"];
    let pruned = 0;
    for (const glob of globs) {
      for (const dir of dirs) {
        if (!prunesDirectory(dir, [glob])) continue;
        pruned++;
        for (const rest of below) {
          assert.ok(matchesAny(`${dir}/${rest}`, [glob]), `${glob} prunes ${dir} but not ${dir}/${rest}`);
        }
      }
    }
    assert.ok(pruned > 10, `the property was exercised (${pruned} prunes)`);
  });
});
