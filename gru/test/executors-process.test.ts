// runArgv and scrubbedEnv: no shell, no inherited secrets, evidence for
// every way a process can fail.

import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, test } from "node:test";
import {
  ArgvError,
  DRAIN_GRACE_MS,
  EXIT_NOT_RUN,
  EXIT_TIMED_OUT,
  OUTPUT_CAP_BYTES,
  runArgv,
  scrubbedEnv,
} from "../src/executors/process.ts";

const NODE = process.execPath;
const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gru-process-")));
after(() => fs.rmSync(base, { recursive: true, force: true }));

function scratch(name: string): string {
  const dir = path.join(base, name);
  fs.mkdirSync(dir);
  return dir;
}

const env = (): Record<string, string> => scrubbedEnv({});

describe("runArgv: argv reaches the program literally", () => {
  test("shell metacharacters are data, not syntax", async () => {
    const cwd = scratch("literal");
    const outcome = await runArgv(
      [NODE, "-e", "console.log(JSON.stringify(process.argv.slice(1)))", "; touch pwned", "$(touch pwned2)", "*"],
      { cwd, env: env(), timeout_ms: 10_000 },
    );
    assert.equal(outcome.exit_code, 0, outcome.stderr);
    assert.deepEqual(JSON.parse(outcome.stdout), ["; touch pwned", "$(touch pwned2)", "*"]);
    assert.deepEqual(fs.readdirSync(cwd), [], "no file was created by a shell");
  });

  test("cwd is the one given", async () => {
    const cwd = scratch("cwd");
    const outcome = await runArgv([NODE, "-e", "process.stdout.write(process.cwd())"], { cwd, env: env(), timeout_ms: 10_000 });
    assert.equal(outcome.stdout, cwd);
  });
});

describe("scrubbedEnv: nothing ambient reaches the child", () => {
  test("only PATH, LANG, HOME and declared extras exist", () => {
    process.env.GRU_TEST_SECRET = "sk-should-never-leak";
    try {
      const scrubbed = scrubbedEnv({ EXTRA: "declared" });
      assert.deepEqual(Object.keys(scrubbed).sort(), ["EXTRA", "HOME", "LANG", "PATH"]);
      assert.equal(scrubbed.LANG, "C.UTF-8");
      assert.equal(scrubbed.HOME, os.tmpdir());
      assert.equal(scrubbed.PATH, process.env.PATH);
    } finally {
      delete process.env.GRU_TEST_SECRET;
    }
  });

  test("the child's printed environment lacks the secret and has the extras", async () => {
    process.env.GRU_TEST_SECRET = "sk-should-never-leak";
    try {
      const outcome = await runArgv([NODE, "-e", "console.log(JSON.stringify(process.env))"], {
        cwd: base,
        env: scrubbedEnv({ GRU_DECLARED: "yes" }),
        timeout_ms: 10_000,
      });
      assert.equal(outcome.exit_code, 0, outcome.stderr);
      const childEnv = JSON.parse(outcome.stdout) as Record<string, string>;
      assert.equal(childEnv.GRU_TEST_SECRET, undefined);
      assert.equal(childEnv.GRU_DECLARED, "yes");
      assert.deepEqual(Object.keys(childEnv).sort(), ["GRU_DECLARED", "HOME", "LANG", "PATH"]);
      assert.ok(!outcome.stdout.includes("sk-should-never-leak"));
    } finally {
      delete process.env.GRU_TEST_SECRET;
    }
  });
});

describe("runArgv: failures are evidence, not exceptions", () => {
  test("a missing binary exits 127 with stderr naming it", async () => {
    const outcome = await runArgv(["gru-no-such-binary-4f1c"], { cwd: base, env: env(), timeout_ms: 10_000 });
    assert.equal(outcome.exit_code, EXIT_NOT_RUN);
    assert.equal(outcome.timed_out, false);
    assert.match(outcome.stderr, /gru-no-such-binary-4f1c/);
    assert.match(outcome.stderr, /ENOENT/);
  });

  test("a spawn that fails synchronously also exits 127", async () => {
    const outcome = await runArgv([NODE, "-e", "0"], { cwd: base, env: { BAD: "a\0b" }, timeout_ms: 10_000 });
    assert.equal(outcome.exit_code, EXIT_NOT_RUN);
    assert.match(outcome.stderr, /could not run/);
  });

  test("an exit code passes through", async () => {
    const outcome = await runArgv([NODE, "-e", "process.exit(3)"], { cwd: base, env: env(), timeout_ms: 10_000 });
    assert.equal(outcome.exit_code, 3);
  });

  test("a signal-terminated process gets 128 + signal number", async () => {
    const outcome = await runArgv([NODE, "-e", "process.kill(process.pid, 'SIGTERM'); setInterval(() => {}, 1000)"], {
      cwd: base,
      env: env(),
      timeout_ms: 10_000,
    });
    assert.equal(outcome.exit_code, 128 + os.constants.signals.SIGTERM);
    assert.equal(outcome.timed_out, false);
  });

  test("a timeout kills the process: exit 124, timed_out true", async () => {
    const outcome = await runArgv([NODE, "-e", "console.log('started'); setInterval(() => {}, 1000)"], {
      cwd: base,
      env: env(),
      timeout_ms: 500,
    });
    assert.equal(outcome.exit_code, EXIT_TIMED_OUT);
    assert.equal(outcome.timed_out, true);
    assert.match(outcome.stdout, /started/, "output before the kill is kept");
    assert.ok(outcome.duration_ms >= 400, `duration ${outcome.duration_ms}`);
  });

  test("a timeout kills the whole process group, not only the leader", async () => {
    // The grandchild inherits the pipes. Killing only the leader would leave
    // them open until DRAIN_GRACE_MS gives up on them.
    const script =
      "require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });" +
      "setInterval(() => {}, 1000)";
    const outcome = await runArgv([NODE, "-e", script], { cwd: base, env: env(), timeout_ms: 500 });
    assert.equal(outcome.exit_code, EXIT_TIMED_OUT);
    assert.ok(outcome.duration_ms < 500 + DRAIN_GRACE_MS - 500, `took ${outcome.duration_ms} ms`);
  });

  test("leftover group members are killed when the leader exits", async () => {
    const script =
      "const c = require('child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' });" +
      "console.log('leader done'); process.exit(0)";
    const outcome = await runArgv([NODE, "-e", script], { cwd: base, env: env(), timeout_ms: 20_000 });
    assert.equal(outcome.exit_code, 0);
    assert.equal(outcome.timed_out, false);
    assert.match(outcome.stdout, /leader done/);
    assert.ok(outcome.duration_ms < DRAIN_GRACE_MS, `took ${outcome.duration_ms} ms`);
  });
});

describe("runArgv: output is capped visibly", () => {
  test("more than 1 MB of stdout keeps head and tail with a truncation marker", async () => {
    const total = 3 * 1024 * 1024;
    const script = `process.stdout.write('HEAD' + 'x'.repeat(${total - 8}) + 'TAIL')`;
    const outcome = await runArgv([NODE, "-e", script], { cwd: base, env: env(), timeout_ms: 20_000 });
    assert.equal(outcome.exit_code, 0);
    const dropped = total - OUTPUT_CAP_BYTES;
    assert.ok(outcome.stdout.includes(`[truncated ${dropped} bytes]`), "marker names the dropped byte count");
    assert.ok(outcome.stdout.startsWith("HEAD"));
    assert.ok(outcome.stdout.endsWith("TAIL"), "the tail, where test runners print verdicts, survives");
    assert.ok(Buffer.byteLength(outcome.stdout) <= OUTPUT_CAP_BYTES + 64);
  });

  test("stderr is capped independently", async () => {
    const script = `process.stderr.write('e'.repeat(${2 * 1024 * 1024})); process.stdout.write('ok')`;
    const outcome = await runArgv([NODE, "-e", script], { cwd: base, env: env(), timeout_ms: 20_000 });
    assert.equal(outcome.stdout, "ok");
    assert.ok(outcome.stderr.includes(`[truncated ${1024 * 1024} bytes]`));
  });

  test("truncation never splits a UTF-8 character", async () => {
    // One ASCII byte then three-byte characters: the head ends inside a
    // character and the tail starts inside one (1 + 3n - 2^19 is 2 mod 3).
    const script = `process.stdout.write('x' + '€'.repeat(${500_000}))`;
    const outcome = await runArgv([NODE, "-e", script], { cwd: base, env: env(), timeout_ms: 20_000 });
    assert.match(outcome.stdout, /\[truncated \d+ bytes\]/);
    assert.ok(!outcome.stdout.includes("�"), "no replacement characters");
  });

  test("output under the cap is returned whole", async () => {
    const outcome = await runArgv([NODE, "-e", "process.stdout.write('y'.repeat(1000))"], {
      cwd: base,
      env: env(),
      timeout_ms: 10_000,
    });
    assert.equal(outcome.stdout, "y".repeat(1000));
  });
});

describe("runArgv: only a malformed request throws", () => {
  const options = { cwd: base, env: {}, timeout_ms: 1000 };
  for (const [label, argv] of [
    ["empty argv", []],
    ["empty program", [""]],
    ["NUL in an argument", [NODE, "a\0b"]],
    ["non-string argument", [NODE, 42]],
    ["not an array", "node -e 1"],
  ] as const) {
    test(label, () => {
      assert.throws(() => runArgv(argv as unknown as string[], options), ArgvError);
    });
  }

  for (const timeout of [0, -1, 1.5, Number.NaN, 2 ** 31]) {
    test(`timeout_ms ${timeout}`, () => {
      assert.throws(() => runArgv([NODE, "-e", "0"], { ...options, timeout_ms: timeout }), RangeError);
    });
  }
});
