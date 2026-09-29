import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { GruConfig } from "../src/config.ts";
import { adHocContract, loadContractSource, parseSlashCommand, startRepl } from "../src/cli/repl.ts";
import { call, fakeBlocks, provider, testIo, turn, type FakeBlocksOptions } from "./terminal-fake-blocks.ts";

function setup(t: { after(fn: () => void): void }, options: FakeBlocksOptions = {}, config: Partial<GruConfig> = {}) {
  const cwd = mkdtempSync(join(tmpdir(), "gru-repl-test-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const fake = fakeBlocks(options);
  const io = testIo({ cwd, env: { HOME: join(cwd, "..", "home") } });
  const fullConfig: GruConfig = {
    providers: [provider("acme"), provider("other")],
    route: "acme/a",
    director: "interactive",
    state_dir: "/outside/state",
    ...config,
  };
  const start = () => startRepl({ io: io.io, blocks: fake.blocks, config: fullConfig, configSource: null });
  return { cwd, fake, io, start };
}

function typeLines(io: ReturnType<typeof testIo>, lines: string[]): void {
  io.stdin.write(lines.map((line) => `${line}\n`).join(""));
  io.stdin.end();
}

test("slash commands are parsed into a name and arguments", () => {
  assert.deepEqual(parseSlashCommand("/model   acme/claude  "), { name: "model", args: ["acme/claude"] });
  assert.deepEqual(parseSlashCommand("/PROBE acme m1"), { name: "probe", args: ["acme", "m1"] });
  assert.deepEqual(parseSlashCommand("/quit"), { name: "quit", args: [] });
});

test("the banner shows the workspace, the route and the unsafe-mode warning in plain words", async (t) => {
  const s = setup(t);
  typeLines(s.io, []);
  assert.equal(await s.start(), 0);
  const out = s.io.stdout();
  assert.match(out, /GRU/);
  assert.ok(out.includes(`workspace  ${s.cwd}`));
  assert.match(out, /route +acme\/a \(anthropic\)/);
  assert.match(out, /UNSAFE_DEVELOPMENT: no isolation backend — commands you approve run with your user's authority/);
});

test("/model switches the route used by the next task", async (t) => {
  const s = setup(t);
  typeLines(s.io, ["first task", "/model other/b", "second task", "/quit"]);
  assert.equal(await s.start(), 0);
  assert.deepEqual(
    s.fake.openOptions.map((open) => open.route?.id),
    ["acme/a", "other/b"],
  );
  assert.match(s.io.stdout(), /route for the next task: other\/b/);
});

test("/model with an unknown provider keeps the current route", async (t) => {
  const s = setup(t);
  typeLines(s.io, ["/model nobody/x", "a task"]);
  await s.start();
  assert.match(s.io.stdout(), /error: unknown provider in route nobody\/x/);
  assert.equal(s.fake.openOptions[0]?.route?.id, "acme/a");
});

test("an error in a task does not end the REPL", async (t) => {
  const s = setup(t, { openSessionError: new Error("state_dir is inside the workspace") });
  typeLines(s.io, ["break please", "/status", "/quit"]);
  assert.equal(await s.start(), 0);
  const out = s.io.stdout();
  assert.match(out, /error: state_dir is inside the workspace/);
  assert.match(out, /last +no episode yet/, "the REPL went on to /status after the failure");
});

test("a route failure mid-task is reported and the REPL continues", async (t) => {
  const s = setup(t, { script: () => [new Error("connection reset")] });
  typeLines(s.io, ["try it", "/status"]);
  assert.equal(await s.start(), 0);
  assert.match(s.io.stdout(), /route error: Error: connection reset/);
  assert.match(s.io.stdout(), /last +ep-fake-1 +closure PASS/);
});

test("/quit exits and nothing after it runs", async (t) => {
  const s = setup(t);
  typeLines(s.io, ["/quit", "a task that must not run"]);
  assert.equal(await s.start(), 0);
  assert.deepEqual(s.fake.contracts, []);
});

test("end of input (Ctrl-D) exits with 0", async (t) => {
  const s = setup(t);
  typeLines(s.io, ["/help"]);
  assert.equal(await s.start(), 0);
  assert.match(s.io.stdout(), /\/model <provider\/model>/);
});

test("unknown slash commands are errors, not tasks", async (t) => {
  const s = setup(t);
  typeLines(s.io, ["/deploy prod"]);
  await s.start();
  assert.match(s.io.stdout(), /error: unknown command \/deploy/);
  assert.deepEqual(s.fake.contracts, []);
});

test("a task without verification checks is announced as unable to close PASS", async (t) => {
  const s = setup(t);
  typeLines(s.io, ["add a feature"]);
  await s.start();
  assert.match(s.io.stdout(), /cannot close PASS/);
  assert.deepEqual(s.fake.contracts[0], {
    task: "add a feature",
    classification: "MATERIAL",
    grant: { scopes: ["workspace:read", "workspace:write"], ttl_seconds: 3600 },
    commands: [],
    verification: { protected: ["gru.contract.json", "gru.config.json"], checks: [], must_fail: [] },
  });
});

test("with no route configured, a task is refused with a hint", async (t) => {
  const s = setup(t, {}, { route: null });
  typeLines(s.io, ["do it"]);
  await s.start();
  assert.match(s.io.stdout(), /no model route selected; use \/model/);
  assert.deepEqual(s.fake.openOptions, []);
});

test("commands and verification come from gru.contract.json, read once at start", async (t) => {
  const s = setup(t);
  const verification = { protected: ["test/**"], checks: [{ id: "unit", argv: ["node", "--test"], timeout_ms: 1000, env: {} }], must_fail: [] };
  const commands = [{ id: "test", argv: ["node", "--test"], consequences: ["EXECUTE_WORKSPACE_CODE"], writes: [], deletes: [], timeout_ms: 1000, env: {} }];
  writeFileSync(join(s.cwd, "gru.contract.json"), JSON.stringify({ commands, verification }));
  const pending = s.start();
  await s.io.waitFor("gru> ");
  // A Minion (or anything else) rewriting the file mid-session is not picked up.
  writeFileSync(join(s.cwd, "gru.contract.json"), JSON.stringify({ commands: [], verification: { protected: [], checks: [] } }));
  typeLines(s.io, ["/contract", "run the tests"]);
  await pending;
  const sent = s.fake.contracts[0] as { commands: unknown; verification: { protected: string[]; checks: unknown[] } };
  assert.deepEqual(sent.commands, commands);
  assert.deepEqual(sent.verification.protected, ["test/**", "gru.contract.json", "gru.config.json"]);
  assert.equal(sent.verification.checks.length, 1);
  assert.doesNotMatch(s.io.stdout(), /cannot close PASS/);
  assert.match(s.io.stdout(), /commands +test/);
});

test("/contract reload is how the Director picks up an edited gru.contract.json", async (t) => {
  const s = setup(t);
  const pending = s.start();
  await s.io.waitFor("gru> ");
  writeFileSync(join(s.cwd, "gru.contract.json"), JSON.stringify({ commands: [], verification: { protected: ["spec/**"], checks: [] } }));
  typeLines(s.io, ["/contract reload", "task"]);
  await pending;
  assert.deepEqual((s.fake.contracts[0] as { verification: { protected: string[] } }).verification.protected, [
    "spec/**",
    "gru.contract.json",
    "gru.config.json",
  ]);
});

test("an unusable gru.contract.json refuses tasks instead of silently dropping the checks", async (t) => {
  const s = setup(t);
  writeFileSync(join(s.cwd, "gru.contract.json"), "{ not json");
  typeLines(s.io, ["do it"]);
  await s.start();
  assert.match(s.io.stdout(), /error: gru\.contract\.json is unusable/);
  assert.deepEqual(s.fake.contracts, []);
});

test("an escalation during a task is answered at the prompt and the answer is not read as a task", async (t) => {
  const s = setup(t, {
    script: () => [turn({ calls: [call("w1", "write_file", { path: "gru.config.json", content: "{}" })] }), turn({ text: "done" })],
    escalate: (c) =>
      c.name === "write_file"
        ? {
            tool: "write_file",
            effect: { kind: "fs.write", path: "gru.config.json", content_sha256: "0".repeat(64), bytes: 2 },
            consequences: ["ALTER_VERIFICATION"],
            reasons: ["ALTER_VERIFICATION always requires Project Director approval"],
          }
        : null,
  });
  const pending = s.start();
  await s.io.waitFor("gru> ");
  s.io.stdin.write("change the config\n");
  await s.io.waitFor("Approve? [y/N]");
  s.io.stdin.write("n\n");
  await s.io.waitFor("Reason:");
  s.io.stdin.write("not in this task\n");
  await s.io.waitFor("Closure");
  s.io.stdin.end();
  assert.equal(await pending, 0);
  assert.equal(s.fake.sessions[0]?.decisions[0]?.decision, "REJECT");
  assert.equal(s.fake.contracts.length, 1, "the Director's answers were not run as tasks");
  assert.match(s.io.stdout(), /REJECTED by director:terminal: not in this task/);
});

test("/providers, /models, /probe, /auto and /status work inside the REPL", async (t) => {
  const s = setup(t);
  typeLines(s.io, ["/providers", "/models acme", "/probe acme acme-model-b", "/auto other", "/status"]);
  await s.start();
  const out = s.io.stdout();
  assert.match(out, /acme +anthropic/);
  assert.match(out, /acme-model-a\nacme-model-b/);
  assert.match(out, /acme-model-b +ok +12 ms/);
  assert.match(out, /route for the next task: other\/other-model-b/);
  assert.match(out, /route +other\/other-model-b/);
});

test("adHocContract and loadContractSource handle a missing file", () => {
  const source = loadContractSource(join(tmpdir(), "definitely-not-a-dir-gru"));
  assert.equal(source.path, null);
  assert.equal(source.error, null);
  assert.equal((adHocContract("x", source) as { classification: string }).classification, "MATERIAL");
});
