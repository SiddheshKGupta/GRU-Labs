// WorkspaceExecutor: bind -> mint (real Gate) -> perform. Each test gets a
// fresh temporary directory laid out as
//   <base>/work        the workspace root
//   <base>/outside     somewhere a Minion must never reach
//   <base>/work-evil   a sibling sharing the root's string prefix

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, test } from "node:test";
import type { Effect } from "../src/avl/actions.ts";
import type { DeclaredCommand } from "../src/avl/consequence.ts";
import { AuthorizedAction, Gate, GateViolation, effectDigest } from "../src/avl/gate.ts";
import { MAX_READ_BYTES, WorkspaceExecutor, isInside } from "../src/executors/workspace.ts";
import { sha256 } from "../src/ledger/canonical.ts";
import { BindError, type Redeem } from "../src/types.ts";

const NODE = process.execPath;

let base = "";
let root = "";
let outside = "";
let sibling = "";
let gate: Gate;
let serial = 0;

const commands: DeclaredCommand[] = [
  {
    id: "hello",
    argv: [NODE, "-e", "console.log('hello from ' + process.cwd()); console.error('a warning')"],
    consequences: ["EXECUTE_WORKSPACE_CODE"],
    writes: [],
    deletes: [],
    timeout_ms: 10_000,
    env: { GRU_DECLARED: "1" },
  },
  {
    id: "fail",
    argv: [NODE, "-e", "console.log('boom'); process.exit(2)"],
    consequences: ["EXECUTE_WORKSPACE_CODE"],
    writes: [],
    deletes: [],
    timeout_ms: 10_000,
    env: {},
  },
  {
    id: "marker",
    argv: [NODE, "-e", "require('fs').writeFileSync('marker.txt', 'ran')"],
    consequences: ["EXECUTE_WORKSPACE_CODE"],
    writes: ["marker.txt"],
    deletes: [],
    timeout_ms: 10_000,
    env: {},
  },
  {
    id: "env",
    argv: [NODE, "-e", "console.log(JSON.stringify(process.env))"],
    consequences: ["EXECUTE_WORKSPACE_CODE"],
    writes: [],
    deletes: [],
    timeout_ms: 10_000,
    env: { GRU_DECLARED: "1" },
  },
];

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gru-workspace-")));
  root = path.join(base, "work");
  outside = path.join(base, "outside");
  sibling = path.join(base, "work-evil");
  for (const dir of [root, outside, sibling, path.join(root, "src")]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(root, "src", "a.txt"), "hello\n");
  fs.writeFileSync(path.join(outside, "secret.txt"), "outside secret\n");
  fs.writeFileSync(path.join(sibling, "secret.txt"), "sibling secret\n");
  gate = new Gate(() => new Date("2026-09-29T12:00:00Z"));
});

afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

const executor = (): WorkspaceExecutor => new WorkspaceExecutor(root, commands);
const redeem: Redeem = (action, digest) => gate.redeem(action, digest);

function writeEffect(filePath: string, content: string): Effect {
  return { kind: "fs.write", path: filePath, content_sha256: sha256(content), bytes: Buffer.byteLength(content) };
}

/** Bind now and mint with the real gate, checking the digest contract on the way. */
function authorize(ws: WorkspaceExecutor, effect: Effect, payload: string | null = null): AuthorizedAction {
  const binding = ws.bind(effect);
  serial++;
  const action = gate.mint({
    authorization_id: `auth-${serial}`,
    proposal_id: `prop-${serial}`,
    effect,
    binding,
    grant_refs: [],
    payload,
    ttl_ms: 60_000,
  });
  assert.equal(action.digest, effectDigest(effect, ws.bind(effect)), "bind is deterministic and matches the minted digest");
  return action;
}

async function run(ws: WorkspaceExecutor, effect: Effect, payload: string | null = null) {
  return ws.perform(authorize(ws, effect, payload), redeem);
}

/** Every file under a directory, with contents, so "nothing changed" is checkable. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const full = path.join(entry.parentPath, entry.name);
    const stat = fs.lstatSync(full);
    if (stat.isFile()) out[path.relative(dir, full)] = fs.readFileSync(full, "utf8");
    else if (stat.isSymbolicLink()) out[path.relative(dir, full)] = `-> ${fs.readlinkSync(full)}`;
  }
  return out;
}

describe("construction", () => {
  test("root is the realpath of an existing directory", () => {
    const link = path.join(base, "link-to-work");
    fs.symlinkSync(root, link);
    assert.equal(new WorkspaceExecutor(link, []).root, root);
  });

  test("a missing root or a file root is refused", () => {
    assert.throws(() => new WorkspaceExecutor(path.join(base, "nope"), []));
    assert.throws(() => new WorkspaceExecutor(path.join(root, "src", "a.txt"), []));
  });

  test("duplicate or malformed commands are refused", () => {
    assert.throws(() => new WorkspaceExecutor(root, [commands[0]!, commands[0]!]), /declared twice/);
    assert.throws(() => new WorkspaceExecutor(root, [{ ...commands[0]!, argv: [] }]));
    assert.throws(() => new WorkspaceExecutor(root, [{ ...commands[0]!, timeout_ms: 0 }]), RangeError);
  });

  test("commands are snapshotted: mutating the caller's copy changes nothing that runs", async () => {
    const mine = structuredClone(commands);
    const ws = new WorkspaceExecutor(root, mine);
    mine[0]!.argv = [NODE, "-e", "require('fs').writeFileSync('hijacked', '')"];
    const result = await run(ws, { kind: "process.run", command_id: "hello" });
    assert.match(result.model_content, /hello from/);
    assert.equal(fs.existsSync(path.join(root, "hijacked")), false);
  });
});

describe("happy paths through mint -> perform with a real Gate", () => {
  test("fs.read returns the text, its hash and a SUPPORTS output", async () => {
    const ws = executor();
    const effect: Effect = { kind: "fs.read", path: "src/a.txt" };
    assert.deepEqual(ws.bind(effect), { real: path.join(root, "src", "a.txt"), type: "file" });
    const result = await run(ws, effect);
    assert.equal(result.ok, true);
    assert.equal(result.model_content, "hello\n");
    assert.deepEqual(result.summary, { path: "src/a.txt", bytes: 6, sha256: sha256("hello\n") });
    assert.deepEqual(result.outputs, [{ label: "read", bytes: "hello\n", relation: "SUPPORTS" }]);
  });

  test("fs.read of a file over 256 KB refuses with an explanation; exactly 256 KB is fine", async () => {
    const ws = executor();
    fs.writeFileSync(path.join(root, "big.txt"), "b".repeat(MAX_READ_BYTES + 1));
    fs.writeFileSync(path.join(root, "edge.txt"), "e".repeat(MAX_READ_BYTES));
    const big = await run(ws, { kind: "fs.read", path: "big.txt" });
    assert.equal(big.ok, false);
    assert.match(big.model_content, /at most 262144 bytes/);
    assert.deepEqual(big.outputs, []);
    const edge = await run(ws, { kind: "fs.read", path: "edge.txt" });
    assert.equal(edge.ok, true);
    assert.equal(edge.model_content.length, MAX_READ_BYTES);
  });

  test("fs.read of bytes that are not UTF-8 is refused, not mangled", async () => {
    const ws = executor();
    fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([0xff, 0xfe, 0x00, 0x80]));
    const result = await run(ws, { kind: "fs.read", path: "bin.dat" });
    assert.equal(result.ok, false);
    assert.match(result.model_content, /not valid UTF-8/);
  });

  test("fs.read keeps a byte-order mark, so the text hashes like the file", async () => {
    const ws = executor();
    fs.writeFileSync(path.join(root, "bom.txt"), "﻿bom");
    const result = await run(ws, { kind: "fs.read", path: "bom.txt" });
    assert.equal(result.model_content, "﻿bom");
    assert.equal(sha256(result.model_content), (result.summary as { sha256: string }).sha256);
  });

  test("fs.list sorts entries and marks directories", async () => {
    const ws = executor();
    fs.writeFileSync(path.join(root, "b.txt"), "");
    fs.mkdirSync(path.join(root, "a-dir"));
    const result = await run(ws, { kind: "fs.list", path: "." });
    assert.equal(result.ok, true);
    assert.equal(result.model_content, "a-dir/\nb.txt\nsrc/");
    assert.deepEqual(result.summary, { path: ".", entries: 3 });
    assert.deepEqual(ws.bind({ kind: "fs.list", path: "." }), { real: root, type: "dir" });
  });

  test("fs.write creates missing directories and a new file", async () => {
    const ws = executor();
    const content = "export const x = 1;\n";
    const effect = writeEffect("lib/deep/x.ts", content);
    assert.deepEqual(ws.bind(effect), { real_parent: root, missing: ["lib", "deep"], target_exists: false });
    const result = await run(ws, effect, content);
    assert.equal(result.ok, true);
    assert.equal(fs.readFileSync(path.join(root, "lib", "deep", "x.ts"), "utf8"), content);
    assert.deepEqual(result.summary, { path: "lib/deep/x.ts", bytes: 20, sha256: sha256(content), created: true });
    assert.deepEqual(result.outputs, [{ label: "written", bytes: content, relation: "SUPPORTS" }]);
  });

  test("fs.write overwrites an existing file", async () => {
    const ws = executor();
    const effect = writeEffect("src/a.txt", "changed");
    assert.deepEqual(ws.bind(effect), { real_parent: path.join(root, "src"), missing: [], target_exists: true });
    const result = await run(ws, effect, "changed");
    assert.equal(fs.readFileSync(path.join(root, "src", "a.txt"), "utf8"), "changed");
    assert.equal((result.summary as { created: boolean }).created, false);
  });

  test("fs.delete removes the file", async () => {
    const ws = executor();
    const result = await run(ws, { kind: "fs.delete", path: "src/a.txt" });
    assert.equal(result.ok, true);
    assert.equal(fs.existsSync(path.join(root, "src", "a.txt")), false);
    assert.deepEqual(result.summary, { path: "src/a.txt" });
  });

  test("process.run runs the declared argv in the root and reports exit and output tails", async () => {
    const ws = executor();
    const effect: Effect = { kind: "process.run", command_id: "hello" };
    assert.deepEqual(ws.bind(effect), {
      argv: commands[0]!.argv,
      cwd: root,
      env_keys: ["GRU_DECLARED", "HOME", "LANG", "PATH"],
    });
    const result = await run(ws, effect);
    assert.equal(result.ok, true);
    assert.match(result.model_content, /^exit 0\n--- stdout \(\d+ bytes\) ---\nhello from /);
    assert.ok(result.model_content.includes(`hello from ${root}`));
    assert.match(result.model_content, /--- stderr \(\d+ bytes\) ---\na warning/);
    const summary = result.summary as Record<string, unknown>;
    assert.equal(summary.command_id, "hello");
    assert.equal(summary.exit_code, 0);
    assert.equal(summary.timed_out, false);
    assert.equal(typeof summary.duration_ms, "number");
    assert.deepEqual(
      result.outputs.map((output) => [output.label, output.relation]),
      [
        ["stdout", "SUPPORTS"],
        ["stderr", "SUPPORTS"],
      ],
    );
  });

  test("process.run with a non-zero exit is ok:false, not a throw", async () => {
    const result = await run(executor(), { kind: "process.run", command_id: "fail" });
    assert.equal(result.ok, false);
    assert.match(result.model_content, /^exit 2\n/);
  });

  test("process.run shows the model only the last 8 KB of each stream", async () => {
    const noisy: DeclaredCommand = {
      ...commands[0]!,
      id: "noisy",
      argv: [NODE, "-e", "process.stdout.write('FIRST' + 'n'.repeat(20000) + 'LAST')"],
    };
    const ws = new WorkspaceExecutor(root, [noisy]);
    const result = await run(ws, { kind: "process.run", command_id: "noisy" });
    assert.match(result.model_content, /--- stdout \(last 8192 of 20009 bytes\) ---/);
    assert.ok(result.model_content.includes("LAST"));
    assert.ok(!result.model_content.includes("FIRST"));
    assert.ok(result.outputs[0]!.bytes.startsWith("FIRST"), "the evidence output keeps everything captured");
  });

  test("process.run env is scrubbed and carries the declared extras", async () => {
    process.env.GRU_TEST_SECRET = "sk-should-never-leak";
    try {
      const result = await run(executor(), { kind: "process.run", command_id: "env" });
      const childEnv = JSON.parse(result.outputs[0]!.bytes) as Record<string, string>;
      assert.equal(childEnv.GRU_TEST_SECRET, undefined);
      assert.equal(childEnv.GRU_DECLARED, "1");
    } finally {
      delete process.env.GRU_TEST_SECRET;
    }
  });

  test("runCheck runs argv in the root with a scrubbed env", async () => {
    process.env.GRU_TEST_SECRET = "sk-should-never-leak";
    try {
      const outcome = await executor().runCheck({
        id: "check",
        argv: [NODE, "-e", "console.log(JSON.stringify({ cwd: process.cwd(), env: process.env }))"],
        timeout_ms: 10_000,
        env: { CHECK_EXTRA: "x" },
      });
      assert.equal(outcome.exit_code, 0, outcome.stderr);
      const seen = JSON.parse(outcome.stdout) as { cwd: string; env: Record<string, string> };
      assert.equal(seen.cwd, root);
      assert.equal(seen.env.GRU_TEST_SECRET, undefined);
      assert.equal(seen.env.CHECK_EXTRA, "x");
    } finally {
      delete process.env.GRU_TEST_SECRET;
    }
  });
});

describe("binding refuses what cannot be bound safely", () => {
  test("a symlink inside the root pointing outside: read, list, write and delete all refused", async () => {
    const ws = executor();
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "link.txt"));
    fs.symlinkSync(outside, path.join(root, "outdir"));
    const before = snapshot(outside);
    const attempts: Effect[] = [
      { kind: "fs.read", path: "link.txt" },
      { kind: "fs.read", path: "outdir/secret.txt" },
      { kind: "fs.list", path: "outdir" },
      writeEffect("link.txt", "pwned"),
      writeEffect("outdir/secret.txt", "pwned"),
      writeEffect("outdir/new.txt", "pwned"),
      { kind: "fs.delete", path: "link.txt" },
      { kind: "fs.delete", path: "outdir/secret.txt" },
    ];
    for (const effect of attempts) {
      assert.throws(() => ws.bind(effect), BindError, `${effect.kind} ${"path" in effect ? effect.path : ""}`);
    }
    assert.throws(() => ws.bind({ kind: "fs.read", path: "link.txt" }), /symlinks are not followed/);
    assert.deepEqual(snapshot(outside), before);
    assert.ok(fs.lstatSync(path.join(root, "link.txt")).isSymbolicLink(), "the link itself is untouched");
  });

  test("write or delete where a parent component is a symlink is refused, even one pointing inside", () => {
    const ws = executor();
    fs.symlinkSync(path.join(root, "src"), path.join(root, "alias"));
    assert.throws(() => ws.bind(writeEffect("alias/b.txt", "x")), /alias is a symlink; symlinks are not followed/);
    assert.throws(() => ws.bind(writeEffect("alias/new/b.txt", "x")), BindError);
    assert.throws(() => ws.bind({ kind: "fs.delete", path: "alias/a.txt" }), /symlinks are not followed/);
  });

  test("read through a directory symlink that stays inside the root is allowed", async () => {
    const ws = executor();
    fs.symlinkSync(path.join(root, "src"), path.join(root, "alias"));
    assert.deepEqual(ws.bind({ kind: "fs.read", path: "alias/a.txt" }), {
      real: path.join(root, "src", "a.txt"),
      type: "file",
    });
  });

  test("a sibling directory sharing the root's prefix is not inside", () => {
    assert.equal(isInside(root, sibling), false);
    assert.equal(isInside(root, path.join(sibling, "secret.txt")), false);
    assert.equal(isInside(root, root), true);
    assert.equal(isInside(root, path.join(root, "src")), true);
    assert.equal(isInside(root, path.join(root, "..foo")), true, "a name starting with .. is still inside");
    assert.equal(isInside(root, base), false);
  });

  test("reaching the sibling through a directory symlink is refused by containment", () => {
    // Only the realpath containment check stands between this read and the
    // sibling's secret: the final component is a regular file and the
    // realpath starts with the root's string.
    const ws = executor();
    fs.symlinkSync(sibling, path.join(root, "evil"));
    assert.throws(() => ws.bind({ kind: "fs.read", path: "evil/secret.txt" }), /resolves outside the workspace/);
    fs.mkdirSync(path.join(sibling, "sub"));
    assert.throws(() => ws.bind({ kind: "fs.list", path: "evil/sub" }), /resolves outside the workspace/);
  });

  test("a hard-linked target is not written", () => {
    const ws = executor();
    fs.linkSync(path.join(outside, "secret.txt"), path.join(root, "hard.txt"));
    assert.throws(() => ws.bind(writeEffect("hard.txt", "pwned")), /hard links/);
    assert.equal(fs.readFileSync(path.join(outside, "secret.txt"), "utf8"), "outside secret\n");
  });

  test("wrong kinds of target are refused", () => {
    const ws = executor();
    assert.throws(() => ws.bind({ kind: "fs.read", path: "src" }), /not a regular file/);
    assert.throws(() => ws.bind({ kind: "fs.read", path: "missing.txt" }), /does not exist/);
    assert.throws(() => ws.bind({ kind: "fs.list", path: "src/a.txt" }), /not a directory/);
    assert.throws(() => ws.bind(writeEffect("src", "x")), /is a directory/);
    assert.throws(() => ws.bind(writeEffect("src/a.txt/b", "x")), /not a directory/);
    assert.throws(() => ws.bind({ kind: "fs.delete", path: "src" }), /not a regular file/);
    assert.throws(() => ws.bind({ kind: "fs.delete", path: "gone/x.txt" }), /does not exist/);
  });

  test("paths must be workspace-relative and in normal form", () => {
    const ws = executor();
    for (const bad of ["../outside/secret.txt", "/etc/passwd", "src/../src/a.txt", "./src/a.txt", "src//a.txt", "a\\b"]) {
      assert.throws(() => ws.bind({ kind: "fs.read", path: bad }), BindError, bad);
    }
    assert.throws(() => ws.bind(writeEffect(".", "x")), BindError);
    assert.throws(() => ws.bind({ kind: "fs.delete", path: "." }), BindError);
  });

  test("an undeclared command cannot be bound", () => {
    assert.throws(() => executor().bind({ kind: "process.run", command_id: "rm-rf" }), /not a declared command/);
  });
});

describe("TOCTOU: the effect is re-bound at execution and the gate compares", () => {
  test("a parent swapped for a symlink after authorization: digest mismatch, nothing written outside", async () => {
    const ws = executor();
    const content = "payload";
    const action = authorize(ws, writeEffect("src/a.txt", content), content);
    fs.rmSync(path.join(root, "src"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "src"));
    const before = snapshot(outside);
    await assert.rejects(ws.perform(action, redeem), (error: Error) => {
      assert.ok(error instanceof GateViolation);
      assert.match(error.message, /does not match the effect authorized/);
      return true;
    });
    assert.deepEqual(snapshot(outside), before);
    assert.equal(fs.existsSync(path.join(outside, "a.txt")), false);
    await assert.rejects(ws.perform(action, redeem), /already used/, "the authorization was spent");
  });

  test("a missing parent created as a symlink after authorization: mismatch", async () => {
    const ws = executor();
    const action = authorize(ws, writeEffect("gen/out.txt", "x"), "x");
    fs.symlinkSync(outside, path.join(root, "gen"));
    await assert.rejects(ws.perform(action, redeem), GateViolation);
    assert.equal(fs.existsSync(path.join(outside, "out.txt")), false);
  });

  test("a target created between authorization and perform: mismatch, the new file survives", async () => {
    const ws = executor();
    const action = authorize(ws, writeEffect("new.txt", "mine"), "mine");
    fs.writeFileSync(path.join(root, "new.txt"), "someone else's");
    await assert.rejects(ws.perform(action, redeem), GateViolation);
    assert.equal(fs.readFileSync(path.join(root, "new.txt"), "utf8"), "someone else's");
  });

  test("a read target swapped for a symlink to a secret: mismatch, nothing returned", async () => {
    const ws = executor();
    const action = authorize(ws, { kind: "fs.read", path: "src/a.txt" });
    fs.rmSync(path.join(root, "src", "a.txt"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(root, "src", "a.txt"));
    await assert.rejects(ws.perform(action, redeem), GateViolation);
  });

  test("a delete target swapped for a directory: mismatch, nothing removed", async () => {
    const ws = executor();
    const action = authorize(ws, { kind: "fs.delete", path: "src/a.txt" });
    fs.rmSync(path.join(root, "src", "a.txt"));
    fs.mkdirSync(path.join(root, "src", "a.txt"));
    await assert.rejects(ws.perform(action, redeem), GateViolation);
    assert.ok(fs.statSync(path.join(root, "src", "a.txt")).isDirectory());
  });

  test("an unbindable effect is still refused when redeem does not object", async () => {
    // Defence in depth: the executor never acts on a binding it could not compute.
    const ws = executor();
    const action = authorize(ws, writeEffect("src/a.txt", "x"), "x");
    fs.rmSync(path.join(root, "src"), { recursive: true });
    fs.symlinkSync(outside, path.join(root, "src"));
    await assert.rejects(ws.perform(action, () => {}), BindError);
    assert.equal(fs.existsSync(path.join(outside, "a.txt")), false);
  });
});

describe("redeem comes before any side effect", () => {
  const refuse: Redeem = () => {
    throw new Error("refused by redeem");
  };

  test("write: nothing is written and no directory is created", async () => {
    const ws = executor();
    const action = authorize(ws, writeEffect("made/new.txt", "x"), "x");
    await assert.rejects(ws.perform(action, refuse), /refused by redeem/);
    assert.equal(fs.existsSync(path.join(root, "made")), false);
  });

  test("delete: the file survives", async () => {
    const ws = executor();
    const action = authorize(ws, { kind: "fs.delete", path: "src/a.txt" });
    await assert.rejects(ws.perform(action, refuse), /refused by redeem/);
    assert.equal(fs.existsSync(path.join(root, "src", "a.txt")), true);
  });

  test("process.run: the process is never spawned", async () => {
    const ws = executor();
    const action = authorize(ws, { kind: "process.run", command_id: "marker" });
    await assert.rejects(ws.perform(action, refuse), /refused by redeem/);
    assert.equal(fs.existsSync(path.join(root, "marker.txt")), false);
    // And the same command does create the marker when redeem allows it.
    await ws.perform(authorize(ws, { kind: "process.run", command_id: "marker" }), redeem);
    assert.equal(fs.readFileSync(path.join(root, "marker.txt"), "utf8"), "ran");
  });

  test("redeem receives the digest recomputed now", async () => {
    const ws = executor();
    const action = authorize(ws, { kind: "fs.read", path: "src/a.txt" });
    let seen = "";
    await ws.perform(action, (a, digest) => {
      seen = digest;
      gate.redeem(a, digest);
    });
    assert.equal(seen, action.digest);
  });
});

describe("forged or inconsistent actions", () => {
  const permissive: Redeem = () => {};

  test("a write whose payload does not hash to content_sha256 is refused", async () => {
    const ws = executor();
    const genuine = authorize(ws, writeEffect("forged.txt", "approved"), "approved");
    // The gate cannot mint this, so it has to be a lookalike object.
    const forged = { ...genuine, effect: genuine.effect, payload: "something else" } as unknown as AuthorizedAction;
    await assert.rejects(ws.perform(forged, permissive), /payload does not hash/);
    assert.equal(fs.existsSync(path.join(root, "forged.txt")), false);
  });

  test("a lookalike action is refused even when redeem would let it through", async () => {
    const ws = executor();
    const genuine = authorize(ws, writeEffect("forged.txt", "approved"), "approved");
    const forged = { ...genuine, effect: genuine.effect, payload: "approved" } as unknown as AuthorizedAction;
    await assert.rejects(ws.perform(forged, permissive), /not an AuthorizedAction/);
    assert.equal(fs.existsSync(path.join(root, "forged.txt")), false);
  });
});

describe("host effects are never bound or performed here", () => {
  const hostEffects: Effect[] = [
    { kind: "host.exec", tool: "Bash", command: "rm -rf /" },
    { kind: "host.fetch", tool: "WebFetch", url: "https://example.com" },
    { kind: "host.other", tool: "Other", input_sha256: sha256("x") },
  ];

  for (const effect of hostEffects) {
    test(`${effect.kind}: bind throws, perform throws without redeeming`, async () => {
      const ws = executor();
      assert.throws(() => ws.bind(effect), /host effects are performed by the host/);
      const action = gate.mint({
        authorization_id: `host-${effect.kind}`,
        proposal_id: "p",
        effect,
        binding: {},
        grant_refs: [],
        payload: null,
        ttl_ms: 60_000,
      });
      let redeemed = false;
      await assert.rejects(
        ws.perform(action, () => {
          redeemed = true;
        }),
        BindError,
      );
      assert.equal(redeemed, false);
    });
  }
});
