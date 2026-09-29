import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { examplesDirectory, main, parseFlags, UsageError, type Command } from "../src/cli/main.ts";
import { call, fakeBlocks, provider, report, testIo, turn } from "./terminal-fake-blocks.ts";

function project(t: { after(fn: () => void): void }) {
  const root = mkdtempSync(join(tmpdir(), "gru-cli-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, "ws");
  mkdirSync(workspace);
  writeFileSync(join(root, "contract.json"), JSON.stringify({ task: "Implement it.", commands: [], verification: { protected: [], checks: [] } }));
  writeFileSync(join(root, "fixture.json"), JSON.stringify({ turns: [] }));
  return { root, workspace, env: { HOME: join(root, "home") } };
}

test("run wires the blocks in order: contract, executor, route, session, loop, close", async (t) => {
  const p = project(t);
  const fake = fakeBlocks();
  const io = testIo({ cwd: p.root, env: p.env });
  const code = await main(
    ["run", "--workspace", "ws", "--contract", "contract.json", "--fixture", "fixture.json", "--director", "deny", "--state", "state"],
    io.io,
    fake.blocks,
  );
  assert.equal(code, 0, io.stderr());
  assert.deepEqual(fake.log, [
    "parseContract",
    "executor",
    "fixtureRoute",
    "openSession",
    "route.open",
    "route.next",
    "session.recordTurn",
    "session.handle:c1",
    "route.next",
    "session.recordTurn",
    "session.close:COMPLETED",
  ]);
  const opened = fake.openOptions[0];
  assert.ok(opened);
  assert.equal(opened.workspace, p.workspace);
  assert.equal(opened.state_dir, join(p.root, "state"));
  assert.equal(opened.minion.id, "minion:implementer");
  assert.equal(opened.minion.trust, "T3");
  assert.equal(opened.route, fake.routes[0]?.descriptor);
  assert.deepEqual(fake.fixtures[0], { turns: [] });
  assert.equal(fake.executors[0]?.root, p.workspace);
});

test("run prints the banner with safety mode in plain words, live calls and the report", async (t) => {
  const p = project(t);
  const io = testIo({ cwd: p.root, env: p.env });
  await main(["run", "--workspace", "ws", "--contract", "contract.json", "--fixture", "fixture.json", "--director", "deny"], io.io, fakeBlocks().blocks);
  const out = io.stdout();
  assert.match(out, /episode\s+ep-fake-1/);
  assert.match(out, /UNSAFE_DEVELOPMENT/);
  assert.match(out, /P8 +code that a command runs has your user's filesystem, network and credential access/);
  assert.match(out, /✓ read_file README\.md/);
  assert.match(out, /Loop ended {2}COMPLETED/);
  assert.match(out, /status +PASS/);
  assert.match(out, /ledger +\/state\/episodes\/ep-fake-1\/ledger\.jsonl/);
});

for (const status of ["FAIL", "PARTIAL", "ABANDONED"] as const) {
  test(`run exits 1 when the closure is ${status}, even if the model said it was done`, async (t) => {
    const p = project(t);
    const fake = fakeBlocks({ report: report(status), script: () => [turn({ text: "Done! Everything passes." })] });
    const io = testIo({ cwd: p.root, env: p.env });
    const code = await main(["run", "--workspace", "ws", "--contract", "contract.json", "--fixture", "fixture.json", "--director", "deny"], io.io, fake.blocks);
    assert.equal(code, 1);
  });
}

test("run --json prints only the report as JSON on stdout", async (t) => {
  const p = project(t);
  const expected = report("PARTIAL");
  const io = testIo({ cwd: p.root, env: p.env });
  const code = await main(
    ["run", "--workspace", "ws", "--contract", "contract.json", "--fixture", "fixture.json", "--director", "deny", "--json"],
    io.io,
    fakeBlocks({ report: expected }).blocks,
  );
  assert.equal(code, 1);
  assert.deepEqual(JSON.parse(io.stdout()), expected);
  assert.match(io.stderr(), /UNSAFE_DEVELOPMENT/, "human-readable progress goes to stderr");
});

test("run uses the config's route through the catalog when no --route or --fixture is given", async (t) => {
  const p = project(t);
  writeFileSync(join(p.root, "gru.config.json"), JSON.stringify({ providers: [provider("acme")], route: "acme/model-b", director: "deny" }));
  const fake = fakeBlocks();
  const io = testIo({ cwd: p.root, env: p.env });
  const code = await main(["run", "--workspace", "ws", "--contract", "contract.json"], io.io, fake.blocks);
  assert.equal(code, 0, io.stderr());
  assert.deepEqual(fake.catalogs[0]?.routed, ["acme/model-b"]);
  assert.equal(fake.openOptions[0]?.route?.id, "acme/model-b");
});

test("--route overrides the config's route", async (t) => {
  const p = project(t);
  writeFileSync(join(p.root, "gru.config.json"), JSON.stringify({ providers: [provider("acme"), provider("other")], route: "acme/model-b" }));
  const fake = fakeBlocks();
  const io = testIo({ cwd: p.root, env: p.env });
  await main(["run", "--workspace", "ws", "--contract", "contract.json", "--route", "other/x", "--director", "deny"], io.io, fake.blocks);
  assert.deepEqual(fake.catalogs[0]?.routed, ["other/x"]);
});

test("run passes a scripted Director from --director script:<file>", async (t) => {
  const p = project(t);
  writeFileSync(
    join(p.root, "director.json"),
    JSON.stringify({ rules: [{ match: { tool: "delete_file" }, decision: "REJECT", reason: "no deleting" }] }),
  );
  const fake = fakeBlocks({
    script: () => [turn({ calls: [call("d1", "delete_file", { path: "test/a.js" })] }), turn({ text: "ok" })],
    escalate: (c) =>
      c.name === "delete_file"
        ? { tool: "delete_file", effect: { kind: "fs.delete", path: "test/a.js" }, consequences: ["DESTROY_WORKSPACE_DATA"], reasons: ["needs approval"] }
        : null,
  });
  const io = testIo({ cwd: p.root, env: p.env });
  await main(["run", "--workspace", "ws", "--contract", "contract.json", "--fixture", "fixture.json", "--director", "script:director.json"], io.io, fake.blocks);
  assert.equal(fake.sessions[0]?.decisions[0]?.decision, "REJECT");
  assert.match(io.stdout(), /REJECTED by director:scripted: no deleting/);
});

test("run usage errors exit 2 with a pointer to --help", async (t) => {
  const p = project(t);
  const cases = [
    ["run", "--contract", "contract.json", "--fixture", "fixture.json"],
    ["run", "--workspace", "ws", "--contract", "contract.json", "--fixture", "f", "--route", "a/b"],
    ["run", "--workspace", "ws", "--contract", "contract.json", "--bogus"],
    ["run", "--workspace", "ws", "--workspace", "ws", "--contract", "contract.json"],
    ["run", "--workspace", "ws", "--contract"],
    ["run", "--workspace", "ws", "--contract", "contract.json", "stray"],
    ["run", "--workspace", "ws", "--contract", "contract.json", "--fixture", "fixture.json", "--director", "maybe"],
    ["run", "--workspace", "ws", "--contract", "contract.json"],
  ];
  for (const argv of cases) {
    const io = testIo({ cwd: p.root, env: p.env });
    const code = await main(argv, io.io, fakeBlocks().blocks);
    assert.equal(code, 2, `${argv.join(" ")}\n${io.stderr()}`);
    assert.match(io.stderr(), /gru run --help/);
  }
});

test("run reports a missing contract file as an error, exit 1, without opening a session", async (t) => {
  const p = project(t);
  const fake = fakeBlocks();
  const io = testIo({ cwd: p.root, env: p.env });
  const code = await main(["run", "--workspace", "ws", "--contract", "nope.json", "--fixture", "fixture.json"], io.io, fake.blocks);
  assert.equal(code, 1);
  assert.match(io.stderr(), /cannot read contract/);
  assert.deepEqual(fake.openOptions, []);
});

test("a session error is reported and the episode is not closed under a borrowed outcome", async (t) => {
  const p = project(t);
  const fake = fakeBlocks({
    handle: () => {
      throw new Error("ledger write failed");
    },
  });
  const io = testIo({ cwd: p.root, env: p.env });
  const code = await main(["run", "--workspace", "ws", "--contract", "contract.json", "--fixture", "fixture.json", "--director", "deny"], io.io, fake.blocks);
  assert.equal(code, 1);
  assert.match(io.stderr(), /ledger write failed/);
  assert.deepEqual(fake.sessions[0]?.closed, []);
});

test("an unknown command prints help and exits 2", async () => {
  const io = testIo();
  const code = await main(["launch"], io.io, fakeBlocks().blocks);
  assert.equal(code, 2);
  assert.match(io.stderr(), /unknown command "launch"/);
  assert.match(io.stderr(), /Commands:/);
});

test("gru with no command and no terminal prints help and exits 2", async () => {
  const io = testIo({ isTTY: false });
  assert.equal(await main([], io.io, fakeBlocks().blocks), 2);
  assert.match(io.stderr(), /needs a terminal/);
});

test("gru with no command on a terminal starts the REPL, which exits 0 at end of input", async (t) => {
  const p = project(t);
  const io = testIo({ isTTY: true, cwd: p.root, env: { ...p.env, NO_COLOR: "1" } });
  io.stdin.end("/quit\n");
  assert.equal(await main([], io.io, fakeBlocks().blocks), 0);
  assert.match(io.stdout(), /governed terminal/);
  assert.match(io.stdout(), /UNSAFE_DEVELOPMENT/);
});

test("--help works globally and per command and exits 0", async () => {
  const global = testIo();
  assert.equal(await main(["--help"], global.io, fakeBlocks().blocks), 0);
  assert.match(global.stdout(), /Commands:/);
  const perCommand = testIo();
  assert.equal(await main(["run", "--help"], perCommand.io, fakeBlocks().blocks), 0);
  assert.match(perCommand.stdout(), /--workspace <dir>/);
});

test("providers prints the table and never a credential value or header", async (t) => {
  const p = project(t);
  writeFileSync(
    join(p.root, "gru.config.json"),
    JSON.stringify({
      providers: [
        provider("acme", { headers: { "x-org": "org-SECRET-HEADER" }, base_url: "https://user:pa55word@llm.acme.test/v1?key=QUERYSECRET" }),
        provider("local", { kind: "openai-compatible", api_key_env: null, base_url: "http://127.0.0.1:11434/v1" }),
      ],
    }),
  );
  const io = testIo({ cwd: p.root, env: { ...p.env, ACME_API_KEY: "sk-live-VALUE-NEVER-PRINTED" } });
  const code = await main(["providers"], io.io, fakeBlocks({ credentials: { acme: "CONFIGURED", local: "NOT_REQUIRED" } }).blocks);
  assert.equal(code, 0, io.stderr());
  const out = io.stdout();
  assert.match(out, /id +kind +base url +credential/);
  assert.match(out, /acme +anthropic +https:\/\/llm\.acme\.test\/v1\?… +CONFIGURED \(env ACME_API_KEY\)/);
  assert.match(out, /local +openai-compatible +http:\/\/127\.0\.0\.1:11434\/v1 +NOT_REQUIRED/);
  for (const secret of ["VALUE-NEVER-PRINTED", "SECRET-HEADER", "pa55word", "QUERYSECRET"]) {
    assert.ok(!out.includes(secret), `printed ${secret}`);
  }
});

test("models, probe and auto use the catalog and report its answers", async (t) => {
  const p = project(t);
  writeFileSync(join(p.root, "gru.config.json"), JSON.stringify({ providers: [provider("acme")] }));
  const models = testIo({ cwd: p.root, env: p.env });
  assert.equal(await main(["models", "acme"], models.io, fakeBlocks().blocks), 0);
  assert.equal(models.stdout(), "acme-model-a\nacme-model-b\n");
  const failing = testIo({ cwd: p.root, env: p.env });
  assert.equal(await main(["probe", "acme", "acme-model-a"], failing.io, fakeBlocks().blocks), 1);
  assert.match(failing.stdout(), /acme-model-a +failed +12 ms +404 not found/);
  const auto = testIo({ cwd: p.root, env: p.env });
  assert.equal(await main(["auto", "acme", "--prefer", "acme-model-a"], auto.io, fakeBlocks().blocks), 0);
  assert.match(auto.stdout(), /selected: acme\/acme-model-b/);
  const missing = testIo({ cwd: p.root, env: p.env });
  assert.equal(await main(["probe", "acme"], missing.io, fakeBlocks().blocks), 2);
  assert.match(missing.stderr(), /missing <model>/);
});

test("extra commands can be registered and appear in help; duplicates are refused", async () => {
  const verify: Command = { name: "verify", summary: "verify a ledger", usage: "Usage: gru verify <episode>\n", run: async (args) => (args[0] === "ok" ? 0 : 1) };
  const io = testIo();
  assert.equal(await main(["verify", "ok"], io.io, fakeBlocks().blocks, [verify]), 0);
  const help = testIo();
  await main(["--help"], help.io, fakeBlocks().blocks, [verify]);
  assert.match(help.stdout(), /verify +verify a ledger/);
  await assert.rejects(main(["--help"], testIo().io, fakeBlocks().blocks, [{ ...verify, name: "run" }]), /registered twice/);
});

test("parseFlags is strict", () => {
  const spec = { flags: { name: "string", json: "boolean" } as const, positionals: ["thing"] };
  assert.deepEqual(parseFlags(["x", "--name=a", "--json"], spec), { flags: { name: "a", json: true }, positionals: ["x"] });
  assert.deepEqual(parseFlags(["--", "--literal"], spec).positionals, ["--literal"]);
  for (const bad of [[], ["x", "y"], ["x", "--json=1"], ["x", "--name"], ["x", "--name", "--json"], ["x", "-n"], ["x", "--name="]]) {
    assert.throws(() => parseFlags(bad, spec), UsageError, JSON.stringify(bad));
  }
});

test("demo copies the example into a fresh workspace and runs it with the fixture and scripted Director", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "gru-demo-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const fake = fakeBlocks();
  const io = testIo({ env: { HOME: join(temp, "home"), TMPDIR: temp } });
  const code = await main(["demo"], io.io, fake.blocks);
  assert.equal(code, 0, io.stderr());
  const examples = examplesDirectory();
  assert.ok(existsSync(join(examples, "slugify", "src", "slugify.js")), `examples not found at ${examples}`);
  assert.deepEqual(fake.contracts[0], JSON.parse(readFileSync(join(examples, "slugify.contract.json"), "utf8")));
  assert.deepEqual(fake.fixtures[0], JSON.parse(readFileSync(join(examples, "slugify.fixture.json"), "utf8")));
  const opened = fake.openOptions[0];
  assert.ok(opened);
  assert.ok(opened.workspace.startsWith(temp), "the demo never runs in the examples directory itself");
  assert.equal(
    readFileSync(join(opened.workspace, "test", "slugify.test.js"), "utf8"),
    readFileSync(join(examples, "slugify", "test", "slugify.test.js"), "utf8"),
  );
  assert.ok(opened.state_dir !== null && opened.state_dir.startsWith(temp));
  assert.ok(!opened.state_dir.startsWith(opened.workspace), "state must sit outside the workspace");
  // The director passed to the session is an observer wrapping the scripted one; check its decision.
  const decision = await opened.director.decide({
    authorization_id: "a",
    proposal_id: "p",
    principal: "minion:implementer",
    tool: "delete_file",
    effect: { kind: "fs.delete", path: "test/slugify.test.js" },
    consequences: ["DESTROY_WORKSPACE_DATA", "ALTER_VERIFICATION"],
    reasons: [],
  });
  assert.equal(decision.actor, "director:scripted");
  assert.equal(decision.decision, "REJECT");
  assert.match(decision.reason, /a README cannot authorize changing them/);
});

test("demo --json prints the report as JSON only", async (t) => {
  const temp = mkdtempSync(join(tmpdir(), "gru-demo-test-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const io = testIo({ env: { HOME: join(temp, "home"), TMPDIR: temp } });
  await main(["demo", "--json"], io.io, fakeBlocks().blocks);
  assert.equal(JSON.parse(io.stdout()).episode_id, "ep-fake-1");
});
